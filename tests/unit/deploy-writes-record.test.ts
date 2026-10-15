// @vitest-environment node
/**
 * Запись выката: deploy.yml после сверки пишет GitHub Deployment «этот sha на
 * проде» (15.10, выкат только проверенного sha; статья Anthropic о source
 * control, находка AR-deploy).
 *
 * Зачем запись. Без автодеплоя образ ПРЕДЫДУЩЕГО коммита строится после ЕГО
 * CI и кончается позже пуша нашего на 15–60 минут — built_at маркера прода
 * его от нашего не отличает (#1762, только хуже), а sha маркер не знает
 * (reason no_git_head). Запись называет коммит, и по ней
 * scripts/wait-for-deploy.sh отвечает точно (сторож wait-for-deploy-record).
 *
 * Запись обязана говорить правду о проде, а не о намерении. Поэтому сторож
 * держит связку целиком и судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10):
 *  - джобу дано право писать записи, шаг стоит после сверки и до смоука;
 *  - шаг сверки ИСПОЛНЯЕТСЯ целиком (заглушки curl и sleep, настоящий git):
 *    в выход уходит sha, который сверка доказала, а не эхо заказа из панели;
 *    образ предыдущего коммита, начатый до нашего заказа сборки, за наш не
 *    сходит — прежний запас 600 с от времени коммита его принимал;
 *  - шаг записи ИСПОЛНЯЕТСЯ с заглушкой gh: тело запроса, статус success,
 *    отказ записи не роняет джоб, пустой sha — записи нет, но вслух.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadWorkflow,
  stepByName,
  evalIf,
  evalTemplate,
  type WorkflowStep,
} from '../helpers/workflow-semantics';

const deploy = loadWorkflow('.github/workflows/deploy.yml');
const job = deploy.jobs['deploy'];
const ASK = 'Ask Timeweb to build this commit';
const VERIFY = 'Verify deploy reached production';
const RECORD = 'Запись выката — этот sha на проде';
const SMOKE = 'Production smoke (каталог, деталь маршрута, MCP read)';

const REPO = 'tourhabk-ui/pos';
const RUN_URL = `https://github.com/${REPO}/actions/runs/4242`;

// curl: Timeweb (панель, список сборок, заказ) и /version.json прода.
const CURL_STUB = `#!/usr/bin/env bash
out=""; wfmt=""; method=""; url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    -X) method="$2"; shift 2;;
    -d|--data) data="$2"; shift 2;;
    -H|--max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
[ -n "$method" ] || { [ -n "$data" ] && method=POST || method=GET; }
printf '%s\\t%s\\n' "$method" "$url" >> "$FAKE_DIR/curl.log"
case "$url" in
  */version.json) key=served;;
  */deploys\\?*) key=deploys;;
  */deploy) key=deploy;;
  */apps/198048) key=app;;
  *) key=other;;
esac
code=$(cat "$FAKE_DIR/$key.code" 2>/dev/null || echo 200)
body=$(cat "$FAKE_DIR/$key.json" 2>/dev/null || echo '{}')
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0
`;

// gh: запись выката и её статус; тело запроса сохраняется для проверки.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.log"
input=""
prev=""
for a in "$@"; do
  [ "$prev" = "--input" ] && input="$a"
  prev="$a"
done
case "$*" in
  *"/statuses"*) [ ! -f "$FAKE_DIR/status-fail" ] || { echo "HTTP 422: status refused" >&2; exit 1; } ;;
  *"/deployments"*)
    [ -z "$input" ] || cp "$input" "$FAKE_DIR/deploy-body.json"
    [ ! -f "$FAKE_DIR/deploy-fail" ] || { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
    cat "$FAKE_DIR/deploy-id" 2>/dev/null || echo 4242 ;;
esac
exit 0
`;

const SLEEP_STUB = '#!/usr/bin/env bash\nexit 0\n';

let work: string;
let bin: string;
let repo: string;
let C0 = ''; // старый коммит — прод на нём, если выкат не доехал
let C1 = ''; // коммит, который проверил CI и чью сборку заказали
let C2 = ''; // более новый коммит (его заказ мог прийти следом)
let NEED = 0; // время коммита C1, epoch

function git(args: string[], cwd = repo): string {
  return execFileSync('git', ['-c', 'color.ui=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'deploy-record-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['curl', CURL_STUB], ['gh', GH_STUB], ['sleep', SLEEP_STUB]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  repo = join(work, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  const commit = (file: string, msg: string) => {
    writeFileSync(join(repo, file), `${msg}\n`);
    git(['add', file]);
    git(['commit', '-q', '-m', msg]);
    return git(['rev-parse', 'HEAD']);
  };
  C0 = commit('a.ts', 'старая правка');
  C1 = commit('b.ts', 'правка, прошедшая CI');
  C2 = commit('c.ts', 'правка следом');
  NEED = Number(git(['show', '-s', '--format=%ct', C1]));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function ctx(outputs: Record<string, Record<string, string>> = {}, eventName = 'workflow_run'): Record<string, unknown> {
  return {
    github: {
      event_name: eventName,
      repository: REPO,
      sha: C2,
      run_id: 4242,
      server_url: 'https://github.com',
      token: 'ghs_test',
      event: { workflow_run: eventName === 'workflow_run' ? { head_sha: C1, conclusion: 'success', event: 'push', head_repository: { full_name: REPO } } : undefined },
    },
    secrets: { TIMEWEB_TOKEN: 'tw-token' },
    vars: {},
    env: deploy.env ?? {},
    steps: Object.fromEntries(Object.entries(outputs).map(([id, o]) => [id, { outputs: o }])),
  };
}

function stepEnv(step: WorkflowStep, c: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { ...(deploy.env ?? {}) };
  for (const [k, v] of Object.entries(step.env ?? {})) {
    const val = evalTemplate(v, c);
    out[k] = val === null || val === undefined ? '' : String(val);
  }
  return out;
}

interface Run { code: number; out: string; outputs: Record<string, string>; curl: string[]; gh: string[]; body: unknown }

function runStep(step: WorkflowStep, env: Record<string, string>, fake: Record<string, string>): Run {
  const fakeDir = mkdtempSync(join(work, 'fake-'));
  for (const [f, body] of Object.entries(fake)) writeFileSync(join(fakeDir, f), body);
  const outputFile = join(fakeDir, 'output.txt');
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['-e', '-c', step.run ?? ''], {
      cwd: repo,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? work,
        FAKE_DIR: fakeDir,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: join(fakeDir, 'summary.md'),
        ...env,
      },
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const read = (f: string) => (existsSync(join(fakeDir, f)) ? readFileSync(join(fakeDir, f), 'utf-8') : '');
  const outputs = Object.fromEntries(
    read('output.txt').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const rawBody = read('deploy-body.json');
  return {
    code,
    out,
    outputs,
    curl: read('curl.log').split('\n').filter(Boolean),
    gh: read('gh.log').split('\n').filter(Boolean),
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

const app = (commit: string) => JSON.stringify({ app: { id: 198048, status: 'active', commit_sha: commit, is_auto_deploy: false } });
const served = (commit: string, builtAt: number) =>
  JSON.stringify({ commit, built_at: new Date(builtAt * 1000).toISOString(), reason: commit === 'unknown' ? 'no_git_head' : undefined });

describe('право и место записи', () => {
  it('джобу выката дано право писать записи выката', () => {
    expect(job.permissions?.deployments).toBe('write');
  });

  it('запись — сразу после сверки и до смоука', () => {
    const names = (job.steps ?? []).map((s) => s.name);
    const v = names.indexOf(VERIFY);
    const r = names.indexOf(RECORD);
    const s = names.indexOf(SMOKE);
    expect(v).toBeGreaterThan(-1);
    expect(r, 'запись «этот sha на проде» стоит не после сверки').toBe(v + 1);
    expect(s, 'запись говорит о проде, а не о смоуке — она раньше смоука').toBeGreaterThan(r);
  });

  it('запись пишется и при ручном выкате, и по зелёному CI', () => {
    const rec = stepByName(job, RECORD);
    expect(evalIf(rec.if, ctx({}, 'workflow_dispatch'))).toBe(true);
    expect(evalIf(rec.if, ctx())).toBe(true);
  });

  it('sha записи берётся из выхода сверки, время заказа сверка берёт у шага заказа', () => {
    const ask = stepByName(job, ASK);
    const verify = stepByName(job, VERIFY);
    expect(ask.id).toBeTruthy();
    expect(verify.id).toBeTruthy();
    const c = ctx({ [ask.id!]: { ordered_at: '1790000000' }, [verify.id!]: { deployed_sha: C1, confirmed_by: 'ordered' } });
    expect(stepEnv(verify, c).ORDERED_AT).toBe('1790000000');
    const env = stepEnv(stepByName(job, RECORD), c);
    expect(env.DEPLOYED_SHA).toBe(C1);
    expect(env.CONFIRMED_BY).toBe('ordered');
    expect(env.DEPLOY_ENVIRONMENT).toBe('vedarai.ru');
  });
});

describe('заказ сборки сообщает время заказа — только когда заказ принят', () => {
  const ask = stepByName(job, ASK);

  it('заказ принят (2xx) — ordered_at в выходе, не раньше запроса', () => {
    const before = Math.floor(Date.now() / 1000);
    const r = runStep(ask, stepEnv(ask, ctx()), { 'app.json': app(C0), 'deploys.json': '{"deploys":[]}' });
    expect(r.code).toBe(0);
    expect(Number(r.outputs.ordered_at)).toBeGreaterThanOrEqual(before);
  });

  it('заказ отвергнут — времени заказа нет', () => {
    const r = runStep(ask, stepEnv(ask, ctx()), { 'app.json': app(C0), 'deploys.json': '{"deploys":[]}', 'deploy.code': '400' });
    expect(r.code).toBe(0);
    expect(r.outputs.ordered_at).toBeUndefined();
  });

  it('Timeweb уже собирает потомка — не заказываем, времени заказа нет', () => {
    const r = runStep(ask, stepEnv(ask, ctx()), {
      'app.json': app(C0), 'deploys.json': JSON.stringify({ deploys: [{ status: 'building', commit_sha: C2 }] }),
    });
    expect(r.outputs.ordered_at).toBeUndefined();
  });
});

// Неподтверждённый исход проходит всё окно сверки (60 опросов сайта, сон
// подменён) — это секунды, а не умолчание vitest.
describe('сверка отдаёт в выход то, что доказала, — и только это', { timeout: 60_000 }, () => {
  const verify = stepByName(job, VERIFY);
  const env = (orderedAt?: number) =>
    stepEnv(verify, ctx(orderedAt ? { ask: { ordered_at: String(orderedAt) } } : {}));

  it('сайт назвал потомка — выкачен он, полным sha', () => {
    const r = runStep(verify, env(NEED + 900), { 'app.json': app(C1), 'served.json': served(C2.slice(0, 12), NEED + 1000) });
    expect(r.code).toBe(0);
    expect(r.outputs.deployed_sha).toBe(C2);
    expect(r.outputs.confirmed_by).toBe('commit');
  });

  it('sha нет, образ начат после нашего заказа — выкачен наш коммит, а не эхо панели', () => {
    // Панель уже показывает более новый заказ (C2) — его сборка могла ещё не
    // доехать. Доказано лишь «прод содержит C1».
    const r = runStep(verify, env(NEED + 900), { 'app.json': app(C2), 'served.json': served('unknown', NEED + 930) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Деплой подтверждён заказом сборки/);
    expect(r.outputs.deployed_sha).toBe(C1);
    expect(r.outputs.confirmed_by).toBe('ordered');
  });

  it('образ предыдущего коммита, законченный после пуша, но начатый до заказа, — не подтверждение', () => {
    // Без автодеплоя сборка предыдущего коммита заказывается после ЕГО CI и
    // кончается позже нашего пуша. Прежнее правило (built_at на 600 с позже
    // коммита) приняло бы этот образ за наш и записало бы ложь о проде.
    const r = runStep(verify, env(NEED + 1800), { 'app.json': app(C1), 'served.json': served('unknown', NEED + 1500) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::НЕ СМОГЛИ ПОДТВЕРДИТЬ/);
    expect(r.outputs.deployed_sha).toBe('');
    expect(r.outputs.confirmed_by).toBe('none');
  });

  it('не заказывали, образ новее коммита на запас — подтверждение временем, выкачен наш', () => {
    const r = runStep(verify, env(), { 'app.json': app(C1), 'served.json': served('unknown', NEED + 4000) });
    expect(r.code).toBe(0);
    expect(r.outputs.deployed_sha).toBe(C1);
    expect(r.outputs.confirmed_by).toBe('built_at');
  });

  it('не заказывали, образ новее коммита на 25 минут — «не знаю», записи нет', () => {
    const r = runStep(verify, env(), { 'app.json': app(C1), 'served.json': served('unknown', NEED + 1500) });
    expect(r.code).toBe(0);
    expect(r.outputs.deployed_sha).toBe('');
  });

  it('сайт назвал старый коммит — красный, выхода для записи нет', () => {
    const r = runStep(verify, env(NEED + 900), { 'app.json': app(C1), 'served.json': served(C0, NEED - 60) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::/);
    expect(r.outputs.deployed_sha).toBeUndefined();
  });
});

describe('шаг записи', () => {
  const rec = stepByName(job, RECORD);
  const env = (deployed: string, by = 'ordered') => stepEnv(rec, ctx({ verify: { deployed_sha: deployed, confirmed_by: by } }));

  it('пишет запись с выкаченным sha в vedarai.ru и ставит ей success', () => {
    const r = runStep(rec, env(C1), {});
    expect(r.code).toBe(0);
    expect(r.body).toEqual(expect.objectContaining({
      ref: C1,
      environment: 'vedarai.ru',
      required_contexts: [],
      auto_merge: false,
      production_environment: true,
    }));
    expect(r.gh[0]).toMatch(new RegExp(`^api -X POST repos/${REPO}/deployments `));
    const status = r.gh.find((l) => l.includes('/deployments/4242/statuses')) ?? '';
    expect(status).toMatch(/state=success/);
    expect(status).toMatch(/environment_url=https:\/\/vedarai\.ru/);
    expect(status).toContain(`log_url=${RUN_URL}`);
    expect(r.out).toMatch(new RegExp(`Запись выката #4242: ${C1.slice(0, 7)}`));
  });

  it('сверка ничего не доказала — записи нет, и это сказано', () => {
    const r = runStep(rec, env('', 'none'), {});
    expect(r.code).toBe(0);
    expect(r.gh).toEqual([]);
    expect(r.out).toMatch(/::warning::Запись выката не создана: сверка не доказала/);
  });

  it('GitHub отказал в записи — выкат не роняется, предупреждение с причиной', () => {
    const r = runStep(rec, env(C1), { 'deploy-fail': '1' });
    expect(r.code, 'выкат уже состоялся — ронять его из-за записи неправда о проде').toBe(0);
    expect(r.out).toMatch(/::warning::Запись выката не создана \(HTTP 403/);
    expect(r.gh.some((l) => l.includes('/statuses'))).toBe(false);
  });

  it('ответ без id — не «записано»', () => {
    const r = runStep(rec, env(C1), { 'deploy-id': 'null' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::Запись выката не создана/);
    expect(r.gh.some((l) => l.includes('/statuses'))).toBe(false);
  });

  it('статус не записан — предупреждение, выкат не роняется', () => {
    const r = runStep(rec, env(C1), { 'status-fail': '1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::Запись выката #4242 создана, статус success не записан/);
  });
});

describe('связка: что сверка доказала, то и записано', () => {
  it('выход сверки уходит в тело записи без потерь', () => {
    const verify = stepByName(job, VERIFY);
    const v = runStep(verify, stepEnv(verify, ctx({ ask: { ordered_at: String(NEED + 900) } })), {
      'app.json': app(C2), 'served.json': served(C2, NEED + 1000),
    });
    expect(v.code).toBe(0);
    const rec = stepByName(job, RECORD);
    const r = runStep(rec, stepEnv(rec, ctx({ [verify.id!]: v.outputs })), {});
    expect((r.body as { ref?: string } | null)?.ref).toBe(C2);
  });
});
