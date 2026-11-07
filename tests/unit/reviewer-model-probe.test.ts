// @vitest-environment node
/**
 * Проба ревьюера (07.11): одни и те же диффы, разные модели —
 * .github/workflows/reviewer-model-probe.yml.
 *
 * Сторож судит поведение (CLAUDE.md §4, 13.10): настоящий bash шагов workflow
 * с подменёнными claude, git и node, а учёт расхода — вызовом
 * scripts/hands-usage.mjs. Что держится:
 *  - ключ ноги уходит только на хост своего вендора, ключи других ног до
 *    claude не доходят вовсе;
 *  - все модели Claude Code в ноге — одна голова (подсказка, подзадачи,
 *    лёгкие вызовы), команда — встроенная /security-review;
 *  - «ревью не состоялось» (нет итога, ошибка API, пустой итог) — красный, а
 *    не «находок нет» (§4.0);
 *  - каждый случай матрицы описан полными sha;
 *  - учёт перебирает ровно матрицу, и расход DeepSeek ложится в книги под
 *    своим вендором; неизвестный вендор — ошибка настройки, а не догадка.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { loadWorkflow, stepByName, evalTemplate, type WorkflowStep } from '../helpers/workflow-semantics';
import { parseExecution, runHandsUsage } from '../../scripts/hands-usage.mjs';

const WF_PATH = '.github/workflows/reviewer-model-probe.yml';
const wf = loadWorkflow(WF_PATH);
const raw = load(readFileSync(WF_PATH, 'utf-8')) as {
  jobs: { review: { strategy: { matrix: { case: string[]; leg: string[] } } } };
};
const MATRIX = raw.jobs.review.strategy.matrix;

const SECRETS = {
  OPENROUTER_API_KEY: 'or-key-7f3a',
  ANTHROPIC_API_KEY: 'console-key-91bc',
  DEEPSEEK_API_KEY: 'ds-key-4d2e',
  CRON_SECRET: 'cron-secret-55aa',
};

let dir = '';
let fake = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reviewer-probe-'));
  fake = join(dir, 'bin');
  mkdirSync(fake);
  mkdirSync(join(dir, 'work'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const p = join(fake, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** Шаг как на раннере: env шага из шаблонов, bash -e, рабочий каталог — временный. */
function runStep(step: WorkflowStep, ctx: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    HOME: dir,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, 'github-output'),
    GITHUB_STEP_SUMMARY: join(dir, 'step-summary'),
    FAKE_DIR: dir,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = String(evalTemplate(v, ctx) ?? '');
  const script = join(dir, 'step.sh');
  writeFileSync(script, step.run ?? '');
  const r = spawnSync('bash', ['-e', script], { cwd: join(dir, 'work'), env, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function outputs(): Record<string, string> {
  const f = join(dir, 'github-output');
  if (!existsSync(f)) return {};
  return Object.fromEntries(
    readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

describe('матрица пробы', () => {
  it('три случая; с run 3 нога — боевая связка ревьюера (ds-flash), описания других ног в шаге остались', () => {
    expect(MATRIX.case).toEqual(['gate-3087', 'pd-2506', 'clean-3089']);
    expect(MATRIX.leg).toEqual(['ds-flash']);
  });

  it('расписания нет: проба — по маркеру и вручную', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
  });
});

describe('ключ ноги — только на хост своего вендора', () => {
  const step = stepByName(wf.jobs.review, 'Ревью');
  const LEGS = [
    { leg: 'opus', provider: '', url: 'https://openrouter.ai/api', keyVar: 'ANTHROPIC_API_KEY', key: SECRETS.OPENROUTER_API_KEY, model: 'anthropic/claude-opus-5.5' },
    { leg: 'opus', provider: 'anthropic', url: 'https://api.anthropic.com', keyVar: 'ANTHROPIC_API_KEY', key: SECRETS.ANTHROPIC_API_KEY, model: 'claude-opus-5-5' },
    { leg: 'ds-pro', provider: '', url: 'https://api.deepseek.com/anthropic', keyVar: 'ANTHROPIC_AUTH_TOKEN', key: SECRETS.DEEPSEEK_API_KEY, model: 'deepseek-v4-pro' },
    { leg: 'ds-flash', provider: '', url: 'https://api.deepseek.com/anthropic', keyVar: 'ANTHROPIC_AUTH_TOKEN', key: SECRETS.DEEPSEEK_API_KEY, model: 'deepseek-flash' },
  ];

  for (const c of LEGS) {
    it(`${c.leg}${c.provider ? ` (${c.provider})` : ''}: ${new URL(c.url).host}, одна голова, /security-review`, () => {
      stub('claude', 'env > "$FAKE_DIR/claude.env"; printf "%s\\n" "$@" > "$FAKE_DIR/claude.args"; echo \'{"type":"result","is_error":false,"result":"ok"}\'');
      const r = runStep(step, {
        matrix: { leg: c.leg, case: 'gate-3087' },
        vars: { AGENTS_PROVIDER: c.provider },
        secrets: SECRETS,
        runner: { temp: dir },
      });
      expect(r.code, r.out).toBe(0);

      const envText = readFileSync(join(dir, 'claude.env'), 'utf-8');
      const env = Object.fromEntries(envText.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      expect(env.ANTHROPIC_BASE_URL).toBe(c.url);
      expect(env[c.keyVar]).toBe(c.key);
      // Второго способа входа рядом нет: отказ читается как «этот ключ».
      const other = c.keyVar === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      expect(env[other]).toBeUndefined();
      // Ключи других ног до claude не доходят ни под каким именем.
      for (const v of Object.values(SECRETS)) {
        if (v !== c.key) expect(envText).not.toContain(v);
      }
      for (const name of ['OPENROUTER_KEY', 'CONSOLE_KEY', 'DEEPSEEK_KEY', 'KEY']) expect(env[name]).toBeUndefined();

      const args = readFileSync(join(dir, 'claude.args'), 'utf-8').split('\n');
      expect(args.slice(0, 2)).toEqual(['-p', '/security-review']);
      expect(args[args.indexOf('--model') + 1]).toBe(c.model);
      for (const alias of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
        expect(env[alias], alias).toBe(c.model);
      }
      expect(Number(args[args.indexOf('--max-turns') + 1])).toBeLessThanOrEqual(100);
      const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
      for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch']) expect(denied).toContain(t);
      // Запреты записи через git --output, чтения через --no-index и /proc —
      // те же, что у боевого ревьюера (security-review.yml): связка пробы та же.
      for (const t of ['Bash(git *--output*)', 'Bash(git *--no-index*)', 'Read(//proc/**)']) expect(denied, t).toContain(t);
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');

      const o = outputs();
      expect(o.model).toBe(c.model);
      expect(o.vendor).toBe(c.leg.startsWith('ds-') ? 'deepseek' : 'anthropic');
    });
  }

  it('ключа ноги нет — красный, claude не зовётся', () => {
    stub('claude', 'touch "$FAKE_DIR/claude.called"');
    const r = runStep(step, {
      matrix: { leg: 'ds-pro', case: 'gate-3087' },
      vars: { AGENTS_PROVIDER: '' },
      secrets: { ...SECRETS, DEEPSEEK_API_KEY: '' },
      runner: { temp: dir },
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Ключа ноги ds-pro/);
    expect(existsSync(join(dir, 'claude.called'))).toBe(false);
  });
});

describe('повтор без мышления — только DeepSeek и только до первого ответа модели', () => {
  const step = stepByName(wf.jobs.review, 'Ревью');
  // Первый запуск — отказ API 400 (с ответом модели перед ним или без),
  // второй, без мышления, — итог.
  const CLAUDE = [
    'echo "${CLAUDE_CODE_DISABLE_THINKING:-on}" >> "$FAKE_DIR/thinking.log"',
    'if [ -z "${CLAUDE_CODE_DISABLE_THINKING:-}" ]; then',
    '  [ -n "${WITH_ANSWER:-}" ] && echo \'{"type":"assistant","message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":1}}}\'',
    '  echo \'{"type":"result","subtype":"success","is_error":true,"result":"API Error: 400 unknown thinking type"}\'',
    'else',
    '  echo \'{"type":"result","subtype":"success","is_error":false,"result":"No vulnerabilities found"}\'',
    'fi',
  ].join('\n');
  const run = (leg: string, extra: Record<string, string> = {}) => {
    stub('claude', CLAUDE);
    return runStep(step, {
      matrix: { leg, case: 'gate-3087' },
      vars: { AGENTS_PROVIDER: '' },
      secrets: SECRETS,
      runner: { temp: dir },
    }, extra);
  };
  const attempts = () => readFileSync(join(dir, 'thinking.log'), 'utf-8').split('\n').filter(Boolean);

  it('DeepSeek: первый запрос отвергнут — вторая попытка без мышления, и это названо', () => {
    const r = run('ds-flash');
    expect(r.code, r.out).toBe(0);
    expect(attempts()).toEqual(['on', '1']);
    expect(outputs().attempt).toBe('2');
    expect(r.out).toMatch(/::warning::ds-flash: API отверг первый запрос — повтор без мышления: API Error: 400/);
    expect(readFileSync(join(dir, 'transcript.jsonl'), 'utf-8')).toContain('No vulnerabilities found');
  });

  it('DeepSeek: отказ после ответа модели — не повторяется, расход первой попытки не теряется', () => {
    run('ds-pro', { WITH_ANSWER: '1' });
    expect(attempts()).toEqual(['on']);
    expect(outputs().attempt).toBe('1');
  });

  it('Opus: отказ API не повторяется — нога сравнения идёт одним путём', () => {
    run('opus');
    expect(attempts()).toEqual(['on']);
    expect(outputs().attempt).toBe('1');
  });
});

describe('ревью состоялось — или красный', () => {
  const step = stepByName(wf.jobs.review, 'Ревью состоялось');
  const ctx = {
    matrix: { case: 'pd-2506', leg: 'ds-flash' },
    steps: { review: { outputs: { model: 'deepseek-flash', seconds: '42' } } },
    runner: { temp: dir },
  };
  const transcript = (lines: unknown[]) =>
    writeFileSync(join(dir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const run = () => runStep(step, { ...ctx, runner: { temp: dir } });

  it('отчёт есть — зелёный, отчёт в логе и в сводке', () => {
    transcript([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.02, result: '# Vuln 1: Утечка ПД: `app/api/safety/rescue-chat/route.ts:130`' },
    ]);
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Vuln 1: Утечка ПД');
    expect(readFileSync(join(dir, 'step-summary'), 'utf-8')).toContain('Vuln 1: Утечка ПД');
  });

  it('ошибка API — красный, хотя Claude Code пишет subtype success', () => {
    transcript([{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 model not supported' }]);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::pd-2506 · ds-flash: ревью не состоялось — API Error: 400/);
  });

  it('итог пуст — красный, это не «находок нет»', () => {
    transcript([{ type: 'result', subtype: 'success', is_error: false, result: '' }]);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::.*итог пуст/);
  });

  it('итога нет (обрыв) или файла нет — красный', () => {
    transcript([{ type: 'assistant', message: { id: 'm1' } }]);
    expect(run().code).toBe(1);
    rmSync(join(dir, 'transcript.jsonl'));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::.*не оставил ни строки/);
  });
});

describe('каждый случай описан полными sha', () => {
  const step = stepByName(wf.jobs.review, 'Дифф случая');

  for (const c of MATRIX.case) {
    it(`${c}: база и голова — полные sha, origin/HEAD — база`, () => {
      stub('git', 'printf "%s\\n" "$*" >> "$FAKE_DIR/git.log"');
      const r = runStep(step, { matrix: { case: c, leg: 'opus' }, runner: { temp: dir } });
      expect(r.code, r.out).toBe(0);
      const log = readFileSync(join(dir, 'git.log'), 'utf-8');
      const base = /update-ref refs\/remotes\/origin\/probe-base (\S+)/.exec(log)?.[1] ?? '';
      expect(base).toMatch(/^[0-9a-f]{40}$/);
      expect(log).toContain('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/probe-base');
      const head = /checkout -q (\S+)$/m.exec(log)?.[1] ?? '';
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      // Оба коммита спрашиваются у GitHub по sha ДО checkout: голова может жить
      // только в refs/pull (ветку PR удаляют после влития), а checkout её не берёт.
      const lines = log.split('\n');
      const fetchAt = lines.findIndex((l) => l.startsWith('fetch '));
      expect(fetchAt, 'коммиты случая не запрашиваются').toBeGreaterThanOrEqual(0);
      expect(fetchAt).toBeLessThan(lines.findIndex((l) => / checkout -q /.test(l)));
      expect(lines[fetchAt].split(' ')).toEqual(expect.arrayContaining([base, head]));
    });
  }

  it('неописанный случай — красный', () => {
    stub('git', 'true');
    const r = runStep(step, { matrix: { case: 'nope', leg: 'opus' }, runner: { temp: dir } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Случай «nope» не описан/);
  });
});

describe('правила ревьюера — те же, что в бою (.github/security-review-rules.md)', () => {
  const diff = stepByName(wf.jobs.review, 'Дифф случая');
  const review = stepByName(wf.jobs.review, 'Ревью');
  const ctx = () => ({ matrix: { case: 'gate-3087', leg: 'ds-flash' }, secrets: SECRETS, runner: { temp: dir } });

  it('правила берутся из коммита пробы до перехода на коммит случая', () => {
    mkdirSync(join(dir, 'work', '.github'), { recursive: true });
    writeFileSync(join(dir, 'work', '.github', 'security-review-rules.md'), 'Правило: дыра в проверке путей — находка.');
    // git «переходит» на коммит случая — файл правил из рабочей копии пропадает.
    stub('git', 'case "$1 $2" in "-c advice.detachedHead=false") rm -rf "$PWD/.github" ;; esac; true');
    const r = runStep(diff, ctx());
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(dir, 'review-rules.md'), 'utf-8')).toBe('Правило: дыра в проверке путей — находка.');
  });

  it('правил нет — ревью без них, и это сказано', () => {
    stub('git', 'true');
    const r = runStep(diff, ctx());
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(dir, 'review-rules.md'), 'utf-8')).toBe('');
    expect(r.out).toMatch(/::notice::.*без правил репозитория/);
  });

  it('ревьюер получает правила дополнением системной подсказки; нет правил — флага нет', () => {
    stub('claude', 'printf "%s\\n" "$@" > "$FAKE_DIR/claude.args"; echo \'{"type":"result","is_error":false,"result":"ok"}\'');
    writeFileSync(join(dir, 'review-rules.md'), 'ПРАВИЛО-1\nПРАВИЛО-2');
    expect(runStep(review, ctx()).code).toBe(0);
    const args = readFileSync(join(dir, 'claude.args'), 'utf-8').split('\n');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('ПРАВИЛО-1');
    expect(args[args.indexOf('--append-system-prompt') + 2]).toBe('ПРАВИЛО-2');
    writeFileSync(join(dir, 'review-rules.md'), '');
    expect(runStep(review, ctx()).code).toBe(0);
    expect(readFileSync(join(dir, 'claude.args'), 'utf-8')).not.toContain('--append-system-prompt');
  });
});

describe('расход пробы — в книги, DeepSeek под своим вендором', () => {
  const step = stepByName(wf.jobs['usage-books'], 'Расход пробы — в книги');
  // Временный каталог создаётся перед каждым тестом — контекст собирается там же.
  const run = () => runStep(step, { secrets: SECRETS, runner: { temp: dir } });

  function artifacts(combos: Array<[string, string]>) {
    for (const [c, leg] of combos) {
      const d = join(dir, 'hand', `hand-usage-${c}-${leg}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'hand-usage.json'), '[]');
    }
  }
  const calls = () =>
    existsSync(join(dir, 'node.log'))
      ? readFileSync(join(dir, 'node.log'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
      : [];

  it('учёт перебирает ровно матрицу; ds-* — deepseek, opus — anthropic', () => {
    stub('node', 'printf \'{"agent":"%s","vendor":"%s","file":"%s","args":"%s"}\\n\' "$AGENT_ID" "$HAND_VENDOR" "$EXECUTION_FILE" "$*" >> "$FAKE_DIR/node.log"');
    const all = MATRIX.case.flatMap((c) => MATRIX.leg.map((l) => [c, l] as [string, string]));
    artifacts(all);
    const r = run();
    expect(r.code, r.out).toBe(0);
    const got = calls();
    expect(got).toHaveLength(all.length);
    for (const [c, leg] of all) {
      const call = got.find((g) => g.file.endsWith(`hand-usage-${c}-${leg}/hand-usage.json`));
      expect(call, `${c} · ${leg}: учёт не звался`).toBeDefined();
      expect(call?.vendor).toBe(leg.startsWith('ds-') ? 'deepseek' : 'anthropic');
      expect(call?.agent).toBe('reviewer-model-probe');
      expect(call?.args).toBe('scripts/hands-usage.mjs --run');
    }
  });

  it('счётчиков ноги нет — предупреждение «расход неизвестен», остальные учтены', () => {
    stub('node', 'printf \'{"file":"%s"}\\n\' "$EXECUTION_FILE" >> "$FAKE_DIR/node.log"');
    artifacts([['gate-3087', 'ds-flash']]);
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(r.out).toMatch(/::warning::pd-2506 · ds-flash: счётчиков нет — расход этой ноги неизвестен/);
  });

  it('учёт одной ноги не прошёл — шаг красный', () => {
    stub('node', 'exit 1');
    artifacts([['clean-3089', 'ds-flash']]);
    expect(run().code).toBe(1);
  });
});

describe('scripts/hands-usage.mjs: вендор считавшего — HAND_VENDOR', () => {
  const RESULT = [{
    type: 'result',
    total_cost_usd: 0.03,
    modelUsage: { 'deepseek-v4-pro': { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 9000 } },
  }];

  it('разбор кладёт вендора в ключ журнала; по умолчанию — anthropic, как у рук', () => {
    expect(parseExecution(RESULT, 'deepseek:').rows.map((r) => r.model)).toEqual(['deepseek:deepseek-v4-pro']);
    expect(parseExecution(RESULT).rows.map((r) => r.model)).toEqual(['anthropic:deepseek-v4-pro']);
  });

  async function report(vendor: string | undefined) {
    const file = join(dir, 'usage.json');
    writeFileSync(file, JSON.stringify(RESULT));
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(init.body);
      return new Response(JSON.stringify({ written: 1, cost_usd_known: 0.004, unknown_cost: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const env: Record<string, string> = { AGENT_ID: 'reviewer-model-probe', EXECUTION_FILE: file, HAND_EXECUTION_FILE: file, CRON_SECRET: SECRETS.CRON_SECRET };
    if (vendor !== undefined) env.HAND_VENDOR = vendor;
    const res = await runHandsUsage({ env, fetchImpl });
    return { res, sent };
  }

  it('HAND_VENDOR=deepseek — строки уходят как deepseek:<модель>', async () => {
    const { res, sent } = await report('deepseek');
    expect(res.exitCode).toBe(0);
    const rows = (JSON.parse(sent[0]) as { rows: Array<{ model: string; cache_read_tokens: number }> }).rows;
    expect(rows.map((r) => r.model)).toEqual(['deepseek:deepseek-v4-pro']);
    expect(rows[0].cache_read_tokens).toBe(9000);
  });

  it('вендор не задан — anthropic, руки считаются как прежде', async () => {
    const { sent } = await report(undefined);
    expect((JSON.parse(sent[0]) as { rows: Array<{ model: string }> }).rows[0].model).toBe('anthropic:deepseek-v4-pro');
  });

  it('DeepSeek: «заявлено» Claude Code — не цена, книги с ним не сверяются (run 2: $0.04 при $1.25 заявленных)', async () => {
    // Книги $0.004 при заявленных $0.03 — расхождение 87%.
    const ds = (await report('deepseek')).res.out.join('\n');
    expect(ds).not.toMatch(/расходятся/);
    expect(ds).toMatch(/::notice::.*цена по книгам \$0\.0040, Claude Code заявил \$0\.0300 — для deepseek это не цена/);
    // У Anthropic заявленное — цена, и сверка прежняя.
    const an = (await report('anthropic')).res.out.join('\n');
    expect(an).toMatch(/::warning::.*расходятся на 87%/);
    expect(an).toMatch(/экшен заявил \$0\.0300/);
  });

  it('неизвестный вендор — ошибка настройки, на прод ничего не уходит', async () => {
    const { res, sent } = await report('openai');
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/::error::reviewer-model-probe: HAND_VENDOR «openai» не знаю/);
    expect(sent).toHaveLength(0);
  });
});
