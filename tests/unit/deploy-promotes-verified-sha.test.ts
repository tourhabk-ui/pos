// @vitest-environment node
/**
 * Выкат только проверенного коммита (аудит 15.10, находка AR-deploy, пункт
 * 1.16 дорожной карты; слово владельца 15.10 — карт-бланш, §6 меняется).
 *
 * До 15.10 прод получал КАЖДЫЙ пуш в main: Timeweb собирал его вебхуком
 * (is_auto_deploy), не дожидаясь CI. Замер 15.10: 805 коммитов в main за
 * семь дней, 183 из них — авто-коммиты README-stats [skip ci]; все они
 * выкатывались, проверенные и нет. deploy.yml при этом уже умел заказать
 * сборку ровно проверенного sha — но правило «main ушёл вперёд — сборку не
 * просим» держалось на вебхуке: голову main соберёт он. Прогон 38716588819
 * (15.10) так и написал про авто-коммит README-stats. Выключи автодеплой,
 * не тронув это правило, — и прод не обновился бы НИКОГДА: голова main
 * почти всегда [skip ci], а его CI не проходит.
 *
 * Сторож держит связку целиком и судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10):
 *  - условия джобов вычисляются по контексту события, а не ищутся строкой;
 *  - шаг заказа сборки и шаг тревоги ИСПОЛНЯЮТСЯ — с заглушками curl и gh
 *    и настоящим git-репозиторием, как в deploy-unknown-is-not-mismatch;
 *  - скрипт timeweb-configure исполняется с подменённым HTTP: dry не пишет,
 *    apply пишет ровно {is_auto_deploy} и сверяет GET после.
 * Что CI на main запускают все пути образа — ci-covers-migrations.test.ts.
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
const ci = loadWorkflow('.github/workflows/ci.yml');
const configure = loadWorkflow('.github/workflows/timeweb-configure.yml');

const REPO = 'tourhabk-ui/pos';
const RUN_URL = 'https://github.com/tourhabk-ui/pos/actions/runs/999';

interface RunOpts {
  conclusion?: string;
  event?: string;
  repo?: string;
  headSha?: string;
  mainSha?: string;
  eventName?: string;
  secrets?: Record<string, string>;
}

function ctx(o: RunOpts = {}): Record<string, unknown> {
  return {
    github: {
      event_name: o.eventName ?? 'workflow_run',
      repository: REPO,
      sha: o.mainSha ?? 'f'.repeat(40),
      run_id: 4242,
      server_url: 'https://github.com',
      token: 'ghs_test',
      event: {
        workflow_run: o.eventName === 'workflow_dispatch' ? undefined : {
          conclusion: o.conclusion ?? 'success',
          event: o.event ?? 'push',
          head_sha: o.headSha ?? 'a'.repeat(40),
          html_url: RUN_URL,
          head_repository: { full_name: o.repo ?? REPO },
        },
      },
    },
    secrets: o.secrets ?? { TIMEWEB_TOKEN: 'tw-token' },
    vars: {},
    env: deploy.env ?? {},
  };
}

/** env шага так, как его соберёт GitHub: workflow-level env + env шага по контексту. */
function stepEnv(step: WorkflowStep, c: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { ...(deploy.env ?? {}) };
  for (const [k, v] of Object.entries(step.env ?? {})) {
    const val = evalTemplate(v, c);
    out[k] = val === null || val === undefined ? '' : String(val);
  }
  return out;
}

// ── Заглушки: curl отвечает по адресу из FAKE_DIR, gh пишет журнал ─────────
let work: string;
let bin: string;

const CURL_STUB = `#!/usr/bin/env bash
out=""; wfmt=""; method=""; url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    -X) method="$2"; shift 2;;
    -d|--data) data="$2"; shift 2;;
    --data-urlencode) printf 'ENC\\t%s\\n' "$2" >> "$FAKE_DIR/curl.log"; [ -n "$method" ] || method=POST; shift 2;;
    -H|--max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
[ -n "$method" ] || { [ -n "$data" ] && method=POST || method=GET; }
printf '%s\\t%s\\t%s\\n' "$method" "$url" "$data" >> "$FAKE_DIR/curl.log"
case "$url" in
  *api.telegram.org*) key=tg;;
  */deploys\\?*) key=deploys;;
  */deploy) key=deploy;;
  */apps/198048) key=app;;
  *) key=other;;
esac
code=$(cat "$FAKE_DIR/$key.code" 2>/dev/null || echo 200)
if [ "$code" = "neterr" ]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
body=$(cat "$FAKE_DIR/$key.json" 2>/dev/null || echo '{}')
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0
`;

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.log"
case "$1 $2" in
  "issue list") if [ -f "$FAKE_DIR/gh-list-fail" ]; then echo "HTTP 403" >&2; exit 1; fi; cat "$FAKE_DIR/issues.json" 2>/dev/null || echo '[]';;
  "issue create") [ ! -f "$FAKE_DIR/gh-write-fail" ] || exit 1; echo "https://github.com/${REPO}/issues/77";;
  "issue comment"|"issue close") [ ! -f "$FAKE_DIR/gh-write-fail" ] || exit 1;;
esac
exit 0
`;

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'color.ui=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

let C0 = ''; // старый проверенный коммит (предок)
let C1 = ''; // коммит, который проверил CI
let C2 = ''; // авто-коммит README-stats [skip ci] — голова main

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'deploy-verified-sha-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);

  const origin = join(work, 'origin.git');
  const repo = join(work, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  const commit = (file: string, msg: string) => {
    writeFileSync(join(repo, file), `${msg}\n`);
    git(['add', file], repo);
    git(['commit', '-q', '-m', msg], repo);
    return git(['rev-parse', 'HEAD'], repo);
  };
  C0 = commit('a.ts', 'старая правка');
  C1 = commit('b.ts', 'правка, прошедшая CI');
  C2 = commit('README.md', 'README-stats: автообновление после мержа [skip ci]');
  // push.negotiate из глобального конфига среды на голом репозитории шумит —
  // для локального origin он не нужен.
  git(['-c', 'push.negotiate=false', 'push', '-q', 'origin', 'main'], repo);
  git(['fetch', '-q', 'origin'], repo);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

interface Fake { [file: string]: string }
interface Run { code: number; out: string; curl: string[]; gh: string[]; summary: string }

function runStep(step: WorkflowStep, env: Record<string, string>, fake: Fake, cwd?: string): Run {
  const fakeDir = mkdtempSync(join(work, 'fake-'));
  for (const [f, body] of Object.entries(fake)) writeFileSync(join(fakeDir, f), body);
  const summary = join(fakeDir, 'summary.md');
  const fullEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? work,
    FAKE_DIR: fakeDir,
    GITHUB_STEP_SUMMARY: summary,
    ...env,
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['-e', '-c', step.run ?? ''], {
      cwd: cwd ?? join(work, 'repo'), env: fullEnv, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const read = (f: string) => (existsSync(join(fakeDir, f)) ? readFileSync(join(fakeDir, f), 'utf-8') : '');
  return {
    code,
    out,
    curl: read('curl.log').split('\n').filter(Boolean),
    gh: read('gh.log').split('\n').filter(Boolean),
    summary: read('summary.md'),
  };
}

const deployJob = deploy.jobs['deploy'];
const alertJob = deploy.jobs['ci-red-alert'];

describe('выкат зовётся только зелёным CI по пушу в main этого репозитория', () => {
  it('триггер — завершение CI на main, а не пуш', () => {
    const wr = deploy.on['workflow_run'] as { workflows?: string[]; types?: string[]; branches?: string[] };
    expect(wr.workflows).toContain('CI');
    expect(wr.types).toContain('completed');
    expect(wr.branches).toEqual(['main']);
    expect(deploy.on['push'], 'выкат по пушу минует CI').toBeUndefined();
  });

  it('зелёный CI по пушу — выкат идёт, тревоги нет', () => {
    expect(evalIf(deployJob.if, ctx())).toBe(true);
    expect(evalIf(alertJob.if, ctx())).toBe(false);
  });

  it('красный CI — выката нет, тревога есть', () => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required']) {
      expect(evalIf(deployJob.if, ctx({ conclusion })), conclusion).toBe(false);
      expect(evalIf(alertJob.if, ctx({ conclusion })), conclusion).toBe(true);
    }
  });

  it('отменённый (заменён свежим пушем) — ни выката, ни тревоги', () => {
    expect(evalIf(deployJob.if, ctx({ conclusion: 'cancelled' }))).toBe(false);
    expect(evalIf(alertJob.if, ctx({ conclusion: 'cancelled' }))).toBe(false);
  });

  it('зелёный CI по PR из форка с веткой main — НЕ выкатывается', () => {
    // branches: [main] у workflow_run сверяет только имя ветки; коммит форка
    // GitHub отдаёт и по адресу основного репозитория.
    expect(evalIf(deployJob.if, ctx({ event: 'pull_request', repo: 'stranger/pos' }))).toBe(false);
    expect(evalIf(deployJob.if, ctx({ event: 'pull_request' }))).toBe(false);
    expect(evalIf(deployJob.if, ctx({ repo: 'stranger/pos' }))).toBe(false);
    expect(evalIf(alertJob.if, ctx({ conclusion: 'failure', repo: 'stranger/pos' }))).toBe(false);
  });

  it('ручной выкат владельца — идёт, тревоги нет', () => {
    expect(evalIf(deployJob.if, ctx({ eventName: 'workflow_dispatch' }))).toBe(true);
    expect(evalIf(alertJob.if, ctx({ eventName: 'workflow_dispatch' }))).toBe(false);
  });
});

describe('выкатывается проверенный sha, а не голова main', () => {
  for (const name of ['Ask Timeweb to build this commit', 'Verify deploy reached production']) {
    it(`${name}: EXPECTED_SHA = head_sha прогона CI`, () => {
      const env = stepEnv(stepByName(deployJob, name), ctx({ headSha: C1, mainSha: C2 }));
      expect(env.EXPECTED_SHA).toBe(C1);
    });
  }
});

describe('CI на main не отменяет идущий прогон — иначе серия пушей не даёт выкатить ничего', () => {
  const cancel = ci.concurrency?.['cancel-in-progress'];
  it('push в main — идущий прогон доживает', () => {
    expect(evalTemplate(cancel ?? false, ctx({ eventName: 'push' }))).toBe(false);
  });
  it('PR — устаревший прогон отменяется, как раньше', () => {
    expect(evalTemplate(cancel ?? false, ctx({ eventName: 'pull_request' }))).toBe(true);
  });
});

describe('заказ сборки: автодеплой выключен — заказываем проверенный коммит сами', () => {
  const ask = stepByName(deployJob, 'Ask Timeweb to build this commit');
  const env = () => stepEnv(ask, ctx({ headSha: C1, mainSha: C2 }));
  const app = (auto: unknown) => JSON.stringify({
    app: { id: 198048, is_auto_deploy: auto, envs: { DATABASE_URL: 'postgres://u:PROD-SECRET@h/db' } },
  });
  const posts = (r: Run) => r.curl.filter((l) => l.startsWith('POST\t') && /\/apps\/198048\/deploy\t/.test(l));

  it('выключен, голова main — README-stats [skip ci]: сборка C1 заказана', () => {
    const r = runStep(ask, env(), { 'app.json': app(false), 'deploys.json': '{"deploys":[]}' });
    expect(r.code).toBe(0);
    expect(posts(r)).toHaveLength(1);
    expect(posts(r)[0]).toContain(`{"commit_sha":"${C1}"}`);
    expect(r.out, 'переменные окружения прода из ответа не печатаются').not.toContain('PROD-SECRET');
  });

  it('настройку не прочитали — тоже заказываем (иначе прод стоит молча)', () => {
    const r = runStep(ask, env(), { 'app.code': '500', 'app.json': '{"error":"x"}', 'deploys.json': '{"deploys":[]}' });
    expect(posts(r)).toHaveLength(1);
    expect(r.out).toMatch(/unknown/);
  });

  it('Timeweb уже собирает потомка C1 — вторую сборку не заказываем', () => {
    const r = runStep(ask, env(), {
      'app.json': app(false),
      'deploys.json': JSON.stringify({ deploys: [{ status: 'building', commit_sha: C2 }] }),
    });
    expect(posts(r)).toHaveLength(0);
    expect(r.out).toMatch(/вторую сборку не просим/);
  });

  it('Timeweb собирает ПРЕДКА C1 — заказываем: более новый проверенный обгоняет старый', () => {
    const r = runStep(ask, env(), {
      'app.json': app(false),
      'deploys.json': JSON.stringify({ deploys: [{ status: 'building', commit_sha: C0 }] }),
    });
    expect(posts(r)).toHaveLength(1);
  });

  it('автодеплой ВКЛЮЧЁН и main ушёл вперёд — не заказываем, но говорим вслух', () => {
    // Переходное состояние и откат: голову соберёт вебхук, а вторая сборка
    // старого коммита погасила бы её (24.09).
    const r = runStep(ask, env(), { 'app.json': app(true), 'deploys.json': '{"deploys":[]}' });
    expect(posts(r)).toHaveLength(0);
    expect(r.out).toMatch(/::warning::Автодеплой Timeweb ВКЛЮЧЁН/);
  });
});

describe('красный CI на main — владелец узнаёт, что выкат стоит', () => {
  const step = (alertJob.steps ?? [])[0];
  const SHA = 'b'.repeat(40);
  const env = (secrets: Record<string, string>) =>
    stepEnv(step, ctx({ conclusion: 'failure', headSha: SHA, secrets }));
  const tgText = (r: Run) => r.curl.filter((l) => l.startsWith('ENC\ttext=')).join('\n');

  it('Telegram доставлен и issue открыт; прогон красный — выката не было', () => {
    const r = runStep(step, env({ TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_OWNER_ID: '171' }), {
      'tg.json': '{"ok":true}', 'issues.json': '[]',
    });
    expect(r.code, 'зелёный «Deploy» по красному CI читался бы как выкат').toBe(1);
    expect(tgText(r)).toContain('Выкат остановлен');
    expect(tgText(r)).toContain(SHA.slice(0, 7));
    expect(tgText(r)).toContain(RUN_URL);
    expect(r.curl.some((l) => l.startsWith('ENC\tchat_id=171'))).toBe(true);
    expect(r.gh.some((l) => l.startsWith('issue create') && l.includes(deploy.env?.STOP_ISSUE_TITLE ?? '?'))).toBe(true);
    expect(r.out).toMatch(/::error::Выкат остановлен/);
    expect(r.summary).toMatch(/Telegram: доставлено/);
  });

  it('открытая тревога уже есть — дописываем в неё, второй не заводим', () => {
    const title = deploy.env?.STOP_ISSUE_TITLE ?? '';
    const r = runStep(step, env({ TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_OWNER_ID: '171' }), {
      'tg.json': '{"ok":true}', 'issues.json': JSON.stringify([{ number: 31, title }]),
    });
    expect(r.gh.some((l) => l.startsWith('issue comment 31'))).toBe(true);
    expect(r.gh.some((l) => l.startsWith('issue create'))).toBe(false);
  });

  it('секретов Telegram нет — предупреждение вслух, issue всё равно открыт', () => {
    const r = runStep(step, env({}), { 'issues.json': '[]' });
    expect(r.out).toMatch(/::warning::В секретах репозитория нет TELEGRAM_BOT_TOKEN/);
    expect(r.curl.some((l) => l.includes('api.telegram.org'))).toBe(false);
    expect(r.gh.some((l) => l.startsWith('issue create'))).toBe(true);
    expect(r.code).toBe(1);
  });

  it('Telegram отказал (ok:false) — не выдаётся за доставку', () => {
    const r = runStep(step, env({ TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_OWNER_ID: '171' }), {
      'tg.code': '403', 'tg.json': '{"ok":false,"description":"Forbidden: bot was blocked"}', 'issues.json': '[]',
    });
    expect(r.out).toMatch(/::warning::Telegram не принял тревогу/);
    expect(r.summary).not.toMatch(/Telegram: доставлено/);
  });

  it('оба канала молчат — «не доставлено никуда», а не тишина', () => {
    const r = runStep(step, env({}), { 'gh-list-fail': '1' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Тревога НЕ ДОСТАВЛЕНА никуда/);
  });
});

describe('успешный выкат закрывает тревогу', () => {
  const close = stepByName(deployJob, 'Выкат возобновлён — закрыть тревогу о красном CI');
  const env = () => stepEnv(close, ctx({ headSha: C1 }));
  const title = () => deploy.env?.STOP_ISSUE_TITLE ?? '';

  it('шаг стоит последним — после сверки и смоука', () => {
    const steps = deployJob.steps ?? [];
    expect(steps[steps.length - 1]?.name).toBe(close.name);
  });

  it('открытая тревога с тем же заголовком — закрыта с sha выката', () => {
    const r = runStep(close, env(), { 'issues.json': JSON.stringify([{ number: 31, title: title() }]) });
    expect(r.code).toBe(0);
    expect(r.gh.some((l) => l.startsWith('issue close 31') && l.includes(C1.slice(0, 7)))).toBe(true);
  });

  it('похожий, но чужой заголовок — не трогаем', () => {
    const r = runStep(close, env(), { 'issues.json': JSON.stringify([{ number: 5, title: `${title()} (старое)` }]) });
    expect(r.gh.some((l) => l.startsWith('issue close'))).toBe(false);
  });

  it('issues не прочитались — предупреждение, выкат не роняется', () => {
    const r = runStep(close, env(), { 'gh-list-fail': '1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::Не смог прочитать открытые issues/);
  });
});

// ── timeweb-configure: задача auto_deploy исполняется с подменённым HTTP ────

const HARNESS = `
import io, json, os, sys, urllib.request, urllib.error
STATE = json.load(open(os.environ['FAKE_STATE']))
LOG = os.environ['FAKE_LOG']
class Resp:
    def __init__(self, status, body): self.status = status; self._b = json.dumps(body).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake_urlopen(req, timeout=None):
    method = req.get_method(); url = req.full_url
    body = json.loads(req.data) if req.data else None
    with open(LOG, 'a') as f: f.write(json.dumps({'method': method, 'url': url, 'body': body}) + '\\n')
    path = url.split('api.timeweb.cloud', 1)[1]
    if path == '/api/v1/apps/198048' and method == 'GET':
        if STATE.get('get_fail'): raise urllib.error.HTTPError(url, 500, 'x', {}, io.BytesIO(b'{}'))
        return Resp(200, {'app': {'id': 198048, 'is_auto_deploy': STATE['auto'], 'envs': {'DATABASE_URL': 'postgres://u:PROD-SECRET@h/db'}}})
    if path == '/api/v1/apps/198048' and method == 'PATCH':
        if not STATE.get('patch_ignored'): STATE['auto'] = body.get('is_auto_deploy')
        return Resp(200, {'app': {}})
    raise urllib.error.HTTPError(url, 404, 'nf', {}, io.BytesIO(b'{}'))
urllib.request.urlopen = fake_urlopen
src = open(os.environ['SCRIPT']).read()
exec(compile(src, 'timeweb-configure', 'exec'), {'__name__': '__main__'})
`;

function configureScript(): string {
  const run = (configure.jobs['configure'].steps ?? []).map((s) => s.run ?? '').join('\n');
  const start = run.indexOf("python3 - <<'PY'");
  expect(start, 'скрипт timeweb-configure не найден').toBeGreaterThan(-1);
  const body = run.slice(run.indexOf('\n', start) + 1);
  return body.slice(0, body.indexOf('\nPY\n'));
}

interface TwRun { code: number; out: string; calls: Array<{ method: string; url: string; body: unknown }> }

function runConfigure(marker: Record<string, unknown>, state: Record<string, unknown>): TwRun {
  const dir = mkdtempSync(join(work, 'tw-'));
  const files = {
    MARKER: join(dir, 'marker.json'), SCRIPT: join(dir, 'script.py'), HARNESS: join(dir, 'harness.py'),
    FAKE_STATE: join(dir, 'state.json'), FAKE_LOG: join(dir, 'calls.log'),
  };
  writeFileSync(files.MARKER, JSON.stringify({ domain: 'vedarai.ru', app_id: 198048, ...marker }));
  writeFileSync(files.SCRIPT, configureScript());
  writeFileSync(files.HARNESS, HARNESS);
  writeFileSync(files.FAKE_STATE, JSON.stringify(state));
  let code = 0;
  let out = '';
  try {
    out = execFileSync('python3', ['-I', files.HARNESS], {
      env: { ...process.env, ...files, TIMEWEB_TOKEN: 'tw-token' }, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = existsSync(files.FAKE_LOG)
    ? readFileSync(files.FAKE_LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TwRun['calls'][number])
    : [];
  return { code, out, calls };
}

describe('timeweb-configure: выключение автодеплоя по маркеру, со сверкой GET', () => {
  const patches = (r: TwRun) => r.calls.filter((c) => c.method === 'PATCH');

  it('dry — только план, PATCH не уходит', () => {
    const r = runConfigure({ mode: 'dry', tasks: ['auto_deploy'], auto_deploy: false }, { auto: true });
    expect(r.code).toBe(0);
    expect(patches(r)).toHaveLength(0);
    expect(r.out).toMatch(/ПЛАН: is_auto_deploy: True -> False/);
  });

  it('apply — PATCH ровно {is_auto_deploy:false}, затем GET подтверждает', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'], auto_deploy: false }, { auto: true });
    expect(r.code).toBe(0);
    expect(patches(r)).toHaveLength(1);
    // Тело — одно поле: PATCH настроек принимает и envs, и лишнее переписало бы прод.
    expect(patches(r)[0].body).toEqual({ is_auto_deploy: false });
    const iPatch = r.calls.findIndex((c) => c.method === 'PATCH');
    expect(r.calls.slice(iPatch + 1).some((c) => c.method === 'GET'), 'сверка GET после записи').toBe(true);
    expect(r.out).toMatch(/сверка GET после записи: False/);
    expect(r.out, 'переменные окружения прода не печатаются').not.toContain('PROD-SECRET');
  });

  it('PATCH «принят», а GET показывает прежнее — прогон красный', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'], auto_deploy: false }, { auto: true, patch_ignored: true });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/настройка НЕ изменилась/);
  });

  it('откат — тот же маркер с true', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'], auto_deploy: true }, { auto: false });
    expect(r.code).toBe(0);
    expect(patches(r)[0]?.body).toEqual({ is_auto_deploy: true });
  });

  it('уже как нужно — ничего не пишем', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'], auto_deploy: false }, { auto: false });
    expect(r.code).toBe(0);
    expect(patches(r)).toHaveLength(0);
  });

  it('значения в маркере нет — умолчания нет, ничего не пишем, красный', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'] }, { auto: true });
    expect(r.code).toBe(1);
    expect(patches(r)).toHaveLength(0);
  });

  it('настройку не прочитали — вслепую не пишем, красный', () => {
    const r = runConfigure({ mode: 'apply', tasks: ['auto_deploy'], auto_deploy: false }, { auto: true, get_fail: true });
    expect(r.code).toBe(1);
    expect(patches(r)).toHaveLength(0);
  });

  it('без задачи auto_deploy настройка не трогается вовсе', () => {
    const r = runConfigure({ mode: 'apply', tasks: [], auto_deploy: false }, { auto: true });
    expect(patches(r)).toHaveLength(0);
  });
});
