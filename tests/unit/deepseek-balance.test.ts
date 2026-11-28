// @vitest-environment node
/**
 * Пустой счёт DeepSeek называется словами и заранее (26.11).
 *
 * В тот день счёт кончился, и ревью безопасности краснело на каждом PR через
 * минуту строкой «API Error: 402 Insufficient Balance» — без комментария в PR
 * и без слова, что делать. Сторож судит поведение: настоящий bash скрипта и
 * шагов с подменёнными curl и gh, разобранный YAML с вычисленными условиями.
 * Что держится:
 *  - scripts/deepseek-balance.sh различает ok / low / empty / unknown / no_key,
 *    ключ — только через stdin curl, остатка в выводе нет (репозиторий
 *    публичный);
 *  - ревью: пустой счёт — красный до установки и до модели, с причиной и
 *    комментарием в PR; ниже порога и «не прочитан» — предупреждение, ревью
 *    идёт; 402 посреди ревью — та же причина; учёту без ревью писать нечего;
 *  - по расписанию: ниже порога — одна issue, пополнили — закрыта; не
 *    прочитан или ключа нет — красный, issue не тронута.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, stepByName, evalIf, evalTemplate, type WorkflowStep } from '../helpers/workflow-semantics';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/deepseek-balance.sh');
const KEY = 'ds-key-7f3a';
const review = loadWorkflow('.github/workflows/security-review.yml').jobs.review as ReturnType<typeof loadWorkflow>['jobs'][string] & { env?: Record<string, string>; outputs?: Record<string, string> };
const cron = loadWorkflow('.github/workflows/deepseek-balance.yml');
const cronJob = cron.jobs.balance as typeof review;

let dir = '';
let fake = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsbal-'));
  fake = join(dir, 'bin');
  mkdirSync(fake);
  mkdirSync(join(dir, 'work', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'work', 'scripts', 'deepseek-balance.sh'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const p = join(fake, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** curl, который отвечает телом и кодом из файлов и записывает, чем его звали. */
function fakeCurl(code: string, body: string): void {
  writeFileSync(join(dir, 'curl.code'), code);
  writeFileSync(join(dir, 'curl.body'), body);
  stub('curl', [
    'printf "%s\\n" "$@" > "$FAKE_DIR/curl.args"',
    'cat > "$FAKE_DIR/curl.stdin"',
    'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'cat "$FAKE_DIR/curl.body" > "$out"',
    'cat "$FAKE_DIR/curl.code"',
  ].join('\n'));
}

function baseEnv(): Record<string, string> {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    HOME: dir,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, 'github-output'),
    GITHUB_STEP_SUMMARY: join(dir, 'step-summary'),
    GITHUB_REPOSITORY: 'tourhabk-ui/pos',
    FAKE_DIR: dir,
  };
}

function runScript(env: Record<string, string>) {
  const r = spawnSync('bash', [SCRIPT], { cwd: join(dir, 'work'), env: { ...baseEnv(), ...env }, encoding: 'utf-8' });
  const fields = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { code: r.status, out: `${r.stdout}${r.stderr}`, fields };
}

function runStep(job: { env?: Record<string, string> }, step: WorkflowStep, ctx: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const env = baseEnv();
  for (const [k, v] of Object.entries({ ...(job.env ?? {}), ...(step.env ?? {}) })) env[k] = String(evalTemplate(v, ctx) ?? '');
  Object.assign(env, extraEnv);
  const script = join(dir, 'step.sh');
  writeFileSync(script, step.run ?? '');
  const r = spawnSync('bash', ['-e', script], { cwd: join(dir, 'work'), env, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function outputs(): Record<string, string> {
  const f = join(dir, 'github-output');
  if (!existsSync(f)) return {};
  return Object.fromEntries(readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

const body = (available: boolean, amount: string, currency = 'USD') =>
  JSON.stringify({ is_available: available, balance_infos: [{ currency, total_balance: amount }] });

describe('scripts/deepseek-balance.sh: пять исходов, ключ — не в аргументах, остатка в выводе нет', () => {
  it.each([
    ['выше порога', '200', body(true, '110.00'), 'ok'],
    ['ниже порога', '200', body(true, '1.20'), 'low'],
    ['is_available=false', '200', body(false, '0.00'), 'empty'],
    ['ноль на счёте', '200', body(true, '0.00'), 'empty'],
    ['юани ниже своего порога', '200', body(true, '10.00', 'CNY'), 'low'],
    ['юани выше своего порога', '200', body(true, '25.00', 'CNY'), 'ok'],
    ['ответ не разобран', '200', 'не json', 'unknown'],
    ['ключ отвергнут', '401', '{"error":"x"}', 'unknown'],
    ['сети нет', '000', '', 'unknown'],
  ])('%s → %s', (_name, code, text, state) => {
    fakeCurl(code, text);
    const r = runScript({ DEEPSEEK_KEY: KEY });
    expect(r.code).toBe(0);
    expect(r.fields.state, r.out).toBe(state);
    // Остаток (110.00, 1.20, 10.00, 25.00) в выводе не появляется — только порог.
    expect(r.out).not.toMatch(/110|1\.20|10\.00|25\.00/);
    expect(readFileSync(join(dir, 'curl.args'), 'utf-8')).not.toContain(KEY);
    expect(readFileSync(join(dir, 'curl.args'), 'utf-8')).toContain('https://api.deepseek.com/user/balance');
    expect(readFileSync(join(dir, 'curl.stdin'), 'utf-8')).toContain(`Authorization: Bearer ${KEY}`);
    expect(r.out).not.toContain(KEY);
  });

  it('порог — 3 USD и 20 CNY, переменной репозитория меняется', () => {
    fakeCurl('200', body(true, '4.00'));
    expect(runScript({ DEEPSEEK_KEY: KEY }).fields).toMatchObject({ state: 'ok', threshold: '3', currency: 'USD' });
    expect(runScript({ DEEPSEEK_KEY: KEY, DEEPSEEK_BALANCE_MIN_USD: '5' }).fields).toMatchObject({ state: 'low', threshold: '5' });
    fakeCurl('200', body(true, '15', 'CNY'));
    expect(runScript({ DEEPSEEK_KEY: KEY }).fields).toMatchObject({ state: 'low', threshold: '20', currency: 'CNY' });
  });

  it('ключа нет — no_key, curl не зовётся', () => {
    fakeCurl('200', body(true, '110.00'));
    const r = runScript({ DEEPSEEK_KEY: '' });
    expect(r.fields.state).toBe('no_key');
    expect(existsSync(join(dir, 'curl.args'))).toBe(false);
  });
});

describe('ревью безопасности: баланс — до установки и до модели', () => {
  const step = stepByName(review, 'Баланс DeepSeek');
  const ctx = { secrets: { DEEPSEEK_API_KEY: KEY }, vars: {}, runner: { temp: '' } };

  it('шаг стоит после «Нужно ли ревью» и до установки Claude Code, при тех же условиях', () => {
    const names = (review.steps ?? []).map((s) => s.name);
    expect(names.indexOf('Баланс DeepSeek')).toBeGreaterThan(names.indexOf('Нужно ли ревью'));
    expect(names.indexOf('Баланс DeepSeek')).toBeLessThan(names.indexOf('Claude Code'));
    expect(evalIf(step.if, { env: { DEEPSEEK_KEY: KEY }, steps: { scope: { outputs: { run: 'true' } } } })).toBe(true);
    expect(evalIf(step.if, { env: { DEEPSEEK_KEY: KEY }, steps: { scope: { outputs: { run: 'false' } } } })).toBe(false);
    expect(evalIf(step.if, { env: { DEEPSEEK_KEY: '' }, steps: { scope: { outputs: { run: 'true' } } } })).toBe(false);
  });

  it('счёт пуст — красный, причина словами, сводка, выход empty', () => {
    fakeCurl('200', body(false, '0.00'));
    const r = runStep(review, step, ctx);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Баланс DeepSeek пуст — ревью безопасности не запускалось/);
    expect(outputs().empty).toBe('true');
    expect(readFileSync(join(dir, 'step-summary'), 'utf-8')).toMatch(/не «находок нет»/);
  });

  it('ниже порога — предупреждение, ревью идёт', () => {
    fakeCurl('200', body(true, '1.00'));
    const r = runStep(review, step, ctx);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::Баланс DeepSeek ниже порога \(3 USD\)/);
    expect(outputs().empty).toBeUndefined();
  });

  it('баланс не прочитан — предупреждение, ревью идёт: «не смог» не равно «пусто»', () => {
    fakeCurl('503', '');
    const r = runStep(review, step, ctx);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::Баланс DeepSeek не прочитан \(HTTP 503\)/);
    expect(outputs().empty).toBeUndefined();
  });

  it('пустой счёт — комментарий в PR; при другом отказе и при успехе — нет', () => {
    const c = stepByName(review, 'Баланс DeepSeek пуст — комментарием в PR');
    const at = (status: string, steps: Record<string, unknown>) => evalIf(c.if, { env: { DEEPSEEK_KEY: KEY }, job: { status }, steps });
    expect(at('failure', { balance: { outputs: { empty: 'true' } } })).toBe(true);
    expect(at('failure', { verdict: { outputs: { no_balance: 'true' } } })).toBe(true);
    expect(at('failure', {})).toBe(false);
    expect(at('success', {})).toBe(false);
    stub('gh', 'printf "%s\\n" "$@" > "$FAKE_DIR/gh.args"; cp "${@: -1}" "$FAKE_DIR/gh.body"');
    const r = runStep(review, c, { github: { token: 't', event: { pull_request: { number: 42 } } } });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(dir, 'gh.args'), 'utf-8').split('\n').slice(0, 3)).toEqual(['pr', 'comment', '42']);
    expect(readFileSync(join(dir, 'gh.body'), 'utf-8')).toMatch(/баланс DeepSeek пуст/);
  });

  it('пустой счёт — учёт расхода не идёт: модель не звали', () => {
    const ctxEmpty = { env: { DEEPSEEK_KEY: KEY }, steps: { scope: { outputs: { run: 'true' } }, balance: { outputs: { empty: 'true' } } } };
    const ctxFull = { env: { DEEPSEEK_KEY: KEY }, steps: { scope: { outputs: { run: 'true' } } } };
    for (const name of ['Выжимка расхода — одни счётчики', 'Счётчики расхода — к учёту']) {
      expect([name, evalIf(stepByName(review, name).if, ctxEmpty)]).toEqual([name, false]);
      expect([name, evalIf(stepByName(review, name).if, ctxFull)]).toEqual([name, true]);
    }
    expect(evalTemplate(review.outputs?.ran ?? '', ctxEmpty)).toBe(false);
    expect(evalTemplate(review.outputs?.ran ?? '', ctxFull)).toBe(true);
  });

  it('402 посреди ревью — красный с той же причиной словами, выход no_balance', () => {
    const verdict = stepByName(review, 'Ревью состоялось');
    writeFileSync(join(dir, 'transcript.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'API Error: 402 Insufficient Balance (request_id: x)' }));
    const r = runStep(review, verdict, { runner: { temp: dir }, steps: { review: { outputs: { model: 'deepseek-flash', seconds: '2', attempt: '1', timed_out: 'false', tampered: 'false', rc: '1' } } } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Ревью безопасности не состоялось: баланс DeepSeek пуст/);
    expect(outputs().no_balance).toBe('true');
  });
});

describe('deepseek-balance.yml: раз в 6 часов, одна issue', () => {
  const bal = stepByName(cronJob, 'Остаток счёта DeepSeek');
  const issue = stepByName(cronJob, 'Issue о балансе');
  const ctx = { secrets: { DEEPSEEK_API_KEY: KEY }, vars: {}, github: { token: 'gh-token' } };

  it('по расписанию и вручную; ключ и токен GitHub — в разных шагах', () => {
    expect(JSON.stringify(cron.on)).toMatch(/schedule/);
    expect(JSON.stringify(cron.on)).toMatch(/workflow_dispatch/);
    expect(JSON.stringify(bal.env)).toContain('secrets.DEEPSEEK_API_KEY');
    expect(JSON.stringify(bal.env)).not.toContain('github.token');
    expect(JSON.stringify(issue.env)).not.toContain('DEEPSEEK');
  });

  it.each([
    ['ключа нет', '', '200', body(true, '9')],
    ['не прочитан', KEY, '500', ''],
  ])('%s — красный', (_n, key, code, text) => {
    fakeCurl(code, text);
    const r = runStep(cronJob, bal, { ...ctx, secrets: { DEEPSEEK_API_KEY: key } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::/);
  });

  it('пуст — не красный (issue скажет), выход empty', () => {
    fakeCurl('200', body(false, '0'));
    const r = runStep(cronJob, bal, ctx);
    expect(r.code).toBe(0);
    expect(outputs().state).toBe('empty');
  });

  /** gh: список открытых issue — из файла, вызовы — в журнал. */
  function fakeGh(openIssues: unknown[], viewBody = ''): void {
    writeFileSync(join(dir, 'gh.list'), JSON.stringify(openIssues));
    writeFileSync(join(dir, 'gh.view'), viewBody);
    stub('gh', [
      'echo "$*" >> "$FAKE_DIR/gh.log"',
      'case "$1 $2" in',
      '  "issue list") cat "$FAKE_DIR/gh.list" ;;',
      '  "issue view") cat "$FAKE_DIR/gh.view" ;;',
      'esac',
    ].join('\n'));
  }
  const log = () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf-8').trim().split('\n') : []);
  const issueCtx = (state: string) => ({ ...ctx, steps: { balance: { outputs: { state, threshold: '3', currency: 'USD' } } } });
  const TITLE = 'Баланс DeepSeek: пополнить счёт';

  it('ниже порога, issue нет — заводится одна', () => {
    fakeGh([{ number: 7, title: 'другое' }]);
    expect(runStep(cronJob, issue, issueCtx('low')).code).toBe(0);
    expect(log().filter((l) => l.startsWith('issue create'))).toHaveLength(1);
  });

  it('issue есть — тело переписывается; стало пусто — один комментарий', () => {
    fakeGh([{ number: 9, title: TITLE }], '<!-- deepseek-balance: low -->\nтекст');
    expect(runStep(cronJob, issue, issueCtx('empty')).code).toBe(0);
    expect(log().some((l) => l.startsWith('issue edit 9'))).toBe(true);
    expect(log().filter((l) => l.startsWith('issue comment 9'))).toHaveLength(1);
    expect(log().some((l) => l.startsWith('issue create'))).toBe(false);
  });

  it('было пусто и осталось — без нового комментария', () => {
    fakeGh([{ number: 9, title: TITLE }], '<!-- deepseek-balance: empty -->\nтекст');
    expect(runStep(cronJob, issue, issueCtx('empty')).code).toBe(0);
    expect(log().some((l) => l.startsWith('issue comment'))).toBe(false);
  });

  it('пополнили — issue закрыта', () => {
    fakeGh([{ number: 9, title: TITLE }]);
    expect(runStep(cronJob, issue, issueCtx('ok')).code).toBe(0);
    expect(log().some((l) => l.startsWith('issue close 9'))).toBe(true);
  });
});
