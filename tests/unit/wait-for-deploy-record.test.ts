// @vitest-environment node
/**
 * Ожидание своей сборки — по записи выката, а не по времени сборки (15.10,
 * выкат только проверенного sha; аудит статьи Anthropic, находка AR-deploy).
 *
 * Пока прод выкатывался вебхуком на каждый пуш, «тот ли код на проде»
 * угадывалось по built_at маркера /version.json: sha маркер не знает
 * (reason no_git_head). С выключенным автодеплоем образ ПРЕДЫДУЩЕГО коммита
 * строится после ЕГО CI и кончается позже пуша нашего на 15–60 минут — по
 * времени от нашего не отличим ничем (#1762, только хуже). deploy.yml теперь
 * пишет GitHub Deployment «этот sha на проде» ПОСЛЕ сверки, и ожидание
 * спрашивает его.
 *
 * Сторож судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10): настоящий bash
 * scripts/wait-for-deploy.sh с подложенным curl, который отвечает
 * заготовленным JSON на /deployments, /compare и /version.json и пишет
 * журнал вызовов. Исходы:
 *  - behind / identical — наш коммит в проде → 0;
 *  - ahead, между ними только .github/ и tests/ → 0, со списком файлов;
 *  - ahead с файлами образа → ждём; REQUIRE_FRESH=1 краснеет, называя D;
 *    время сборки при читаемой записи НЕ спрашивается (иначе вернулась бы
 *    болезнь #1762);
 *  - D сменился на содержащий наш → 0; сравнение — один раз на D;
 *  - отказ API / битый JSON → «не смог прочитать запись выката — ждём по
 *    built_at», и запасной путь не мягче прежнего;
 *  - без токена GitHub не опрашивается вовсе;
 *  - усечённый список файлов и переименование из образа — не «вне образа».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow } from '../helpers/workflow-semantics';

const SCRIPT = join(process.cwd(), 'scripts/wait-for-deploy.sh');

const WANT = 'a'.repeat(40);
const D1 = '1'.repeat(40);
const D2 = '2'.repeat(40);
const PUSH_ISO = '2026-10-15T10:00:00Z';
const PUSH = Date.parse(PUSH_ISO) / 1000;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

const CURL_STUB = `#!/usr/bin/env bash
out=""; wfmt=""; url=""; auth=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    -H) case "$2" in Authorization:*) auth=1;; esac; shift 2;;
    --max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
printf '%s\\t%s\\n' "$url" "$auth" >> "$FAKE_DIR/curl.log"
case "$url" in
  */version.json) key=version;;
  */deployments\\?*) key=deployments;;
  */compare/*) b="\${url##*/compare/}"; key="compare-\${b:0:7}";;
  *) key=other;;
esac
# Последовательность ответов: <key>.seq — имя ответа на каждый вызов по
# порядку, последний повторяется.
if [ -f "$FAKE_DIR/$key.seq" ]; then
  n=$(cat "$FAKE_DIR/$key.n" 2>/dev/null || echo 0)
  total=$(wc -l < "$FAKE_DIR/$key.seq")
  idx=$(( n < total ? n + 1 : total ))
  echo $((n + 1)) > "$FAKE_DIR/$key.n"
  key=$(sed -n "\${idx}p" "$FAKE_DIR/$key.seq")
fi
code=$(cat "$FAKE_DIR/$key.code" 2>/dev/null || echo 200)
if [ "$code" = "neterr" ]; then echo "curl: (7) Failed to connect" >&2; [ -z "$wfmt" ] || printf '000'; exit 7; fi
body=$(cat "$FAKE_DIR/$key.json" 2>/dev/null || echo '{}')
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0
`;

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'wait-record-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

interface Call { url: string; auth: boolean }
interface Run { code: number; out: string; calls: Call[] }

type Fake = Record<string, string>;

function runWait(env: Record<string, string>, fake: Fake, opts: { token?: boolean } = {}): Run {
  const fakeDir = mkdtempSync(join(work, 'fake-'));
  for (const [f, body] of Object.entries(fake)) writeFileSync(join(fakeDir, f), body);
  const fullEnv: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? work,
    FAKE_DIR: fakeDir,
    BASE: 'https://vedarai.ru',
    WANT_SHA: WANT,
    NEED_AFTER: PUSH_ISO,
    GITHUB_REPOSITORY: 'tourhabk-ui/pos',
    ATTEMPTS: '3',
    SLEEP: '0',
    GH_EVERY: '0',
    ...(opts.token === false ? {} : { GH_TOKEN: 'ghs_test' }),
    ...env,
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT], { cwd: fakeDir, env: fullEnv, encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const log = existsSync(join(fakeDir, 'curl.log')) ? readFileSync(join(fakeDir, 'curl.log'), 'utf-8') : '';
  const calls = log.split('\n').filter(Boolean).map((l) => {
    const [url, auth] = l.split('\t');
    return { url, auth: auth === '1' };
  });
  return { code, out, calls };
}

const github = (r: Run) => r.calls.filter((c) => c.url.includes('api.github.com'));
const deploymentCalls = (r: Run) => r.calls.filter((c) => /\/deployments\?/.test(c.url));
const compareCalls = (r: Run) => r.calls.filter((c) => c.url.includes('/compare/'));

const deployments = (...rows: Array<{ id: number; sha: string }>) =>
  JSON.stringify(rows.map((x) => ({ ...x, environment: 'vedarai.ru', ref: x.sha })));
const compare = (status: string, files?: Array<{ filename: string; previous_filename?: string }>) =>
  JSON.stringify({ status, ...(files ? { files: files.map((f) => ({ status: 'modified', ...f })) } : {}) });
/** Маркер прода: sha не знает, время сборки — как скажут. */
const version = (builtAt: number) =>
  JSON.stringify({ commit: 'unknown', built_at: iso(builtAt), reason: 'no_git_head' });

/** Образ «из будущего»: по времени — заведомо новее пуша. */
const FAR_FUTURE = version(PUSH + 100_000);

describe('запись выката содержит наш коммит — в проде', () => {
  it('behind: наш коммит предок выкаченного → 0', () => {
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('behind', []),
      'version.json': version(PUSH - 3600),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/в проде: последняя запись выката — 1111111 \(#7\), сравнение: behind/);
  });

  it('identical: выкачен ровно наш → 0', () => {
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: WANT }),
      'compare-aaaaaaa.json': compare('identical', []),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/сравнение: identical/);
  });

  it('свежей считается запись с наибольшим id, а не первая в выдаче', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 5, sha: D1 }, { id: 9, sha: D2 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'app/page.tsx' }]),
      'compare-2222222.json': compare('behind', []),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2222222 \(#9\)/);
  });

  it('ahead, между ними только маркеры .github/triggers и тесты → 0 со списком', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [
        { filename: '.github/triggers/prod-check.json' },
        { filename: 'tests/unit/x.test.ts' },
      ]),
      'version.json': version(PUSH - 3600),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/между выкаченным 1111111 \(#7\) и нашим коммитом только файлы вне образа: \.github\/triggers\/prod-check\.json, tests\/unit\/x\.test\.ts/);
  });
});

describe('запись выката не содержит наш код — ждём, время сборки не спрашивается', () => {
  it('ahead с app/… и образом «из будущего»: REQUIRE_FRESH краснеет и называет D', () => {
    // Образ новее пуша на сутки — запасной путь сказал бы «доехало». При
    // читаемой записи он не спрашивается: это и есть ложное «доехало» #1762.
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: '.github/triggers/x.json' }, { filename: 'app/page.tsx' }]),
      'version.json': FAR_FUTURE,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Своей сборки не дождались/);
    expect(r.out).toMatch(/последняя запись выката: выкачен 1111111 \(#7\); между ним и нашим коммитом есть файлы образа: app\/page\.tsx/);
    expect(r.out).not.toMatch(/прод на сборке новее нашего коммита/);
  });

  it('без REQUIRE_FRESH — «не дождались» вслух, прогон идёт дальше', () => {
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'lib/x.ts' }]),
      'version.json': FAR_FUTURE,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/своей сборки не дождались .* прогон идёт на том коде, что есть \(прод отдаёт unknown; последняя запись выката: выкачен 1111111/);
  });

  it('diverged — ждём и говорим', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('diverged', [{ filename: '.github/x.yml' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/не в его линии \(diverged\)/);
  });

  it('D сменился на содержащий наш → 0; сравнение — один раз на каждый D', () => {
    const r = runWait({ REQUIRE_FRESH: '1', ATTEMPTS: '6' }, {
      'deployments.seq': 'dep-1\ndep-1\ndep-1\ndep-2\n',
      'dep-1.json': deployments({ id: 7, sha: D1 }),
      'dep-2.json': deployments({ id: 8, sha: D2 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'app/page.tsx' }]),
      'compare-2222222.json': compare('behind', []),
      'version.json': FAR_FUTURE,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2222222 \(#8\), сравнение: behind \(попытка 4\)/);
    expect(deploymentCalls(r)).toHaveLength(4);
    expect(compareCalls(r).map((c) => c.url.split('/compare/')[1])).toEqual([
      `${D1}...${WANT}`,
      `${D2}...${WANT}`,
    ]);
  });
});

describe('список файлов сравнения, который «вне образа» не доказывает', () => {
  it('усечённый на 300 файлов — не «вне образа», даже если все из .github/', () => {
    const files = Array.from({ length: 300 }, (_, k) => ({ filename: `.github/triggers/m${k}.json` }));
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', files),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/сравнение с нашим коммитом усечено \(300 файлов\)/);
  });

  it('переименование из app/ в .github/ — образ изменился', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: '.github/old-route.ts', previous_filename: 'app/api/x/route.ts' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/есть файлы образа: app\/api\/x\/route\.ts/);
  });

  it('ответ без списка файлов — не «вне образа»', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead'),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/не назвало файлов/);
  });

  it('путь, лишь начинающийся похоже (testsuite/, .githubx/), — в образе', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'testsuite/a.ts' }, { filename: '.githubx/b.ts' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/есть файлы образа: testsuite\/a\.ts, \.githubx\/b\.ts/);
  });
});

describe('запись не прочитать — запасной путь, сказанный словами и не мягче прежнего', () => {
  it('отказ API (403) — «не смог прочитать запись выката — ждём по built_at»; образ на 65+ мин новее пуша → 0', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.code': '403',
      'deployments.json': '{"message":"Resource not accessible by integration"}',
      'version.json': version(PUSH + 4000),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/не смог прочитать запись выката \(список записей: HTTP 403/);
    expect(r.out).toMatch(/— ждём по built_at/);
    expect(r.out).toMatch(/прод на сборке новее нашего коммита: unknown, built_at минус пуш = 4000с/);
  });

  it('запасной путь не принимает образ «на 700 с новее пуша» — прежние 600 с его бы приняли', () => {
    // Без автодеплоя такой образ — почти наверняка сборка предыдущего
    // коммита, заказанная после его CI (шапка скрипта).
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.code': '500',
      'version.json': version(PUSH + 700),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/запись выката не прочитана: список записей: HTTP 500/);
  });

  it('битый JSON при HTTP 200 — «не смог», а не «доехало»', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': '<html>rate limited</html>',
      'version.json': version(PUSH - 60),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/не смог прочитать запись выката \(список записей: ответ не разобран\)/);
  });

  it('сеть не дошла — «000», тоже «не смог»', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.code': 'neterr',
      'version.json': version(PUSH - 60),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/не смог прочитать запись выката \(список записей: HTTP 000/);
  });

  it('сравнение не удалось — запасной путь сейчас, и сравнение повторяется на том же D', () => {
    const r = runWait({ REQUIRE_FRESH: '1', ATTEMPTS: '3' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.seq': 'cmp-fail\ncmp-ok\n',
      'cmp-fail.code': '502',
      'cmp-ok.json': compare('behind', []),
      'version.json': version(PUSH - 60),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/не смог прочитать запись выката \(сравнение 1111111\.\.\.aaaaaaa: HTTP 502/);
    expect(compareCalls(r)).toHaveLength(2);
  });

  it('записей ещё нет ни одной — так и сказано, ждём по built_at', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': '[]',
      'version.json': version(PUSH - 60),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/записи выката в окружении vedarai\.ru нет ни одной — ждём по built_at/);
  });

  it('точный sha маркера принимается и в запасном пути', () => {
    const r = runWait({}, {
      'deployments.code': '500',
      'version.json': JSON.stringify({ commit: WANT, built_at: iso(PUSH + 60) }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/прод на нашем коммите aaaaaaa/);
  });
});

describe('к GitHub — с токеном и редко', () => {
  it('без токена GitHub не опрашивается вовсе; запасной путь назван', () => {
    const r = runWait({}, { 'version.json': version(PUSH + 4000) }, { token: false });
    expect(github(r)).toEqual([]);
    expect(r.out).toMatch(/запись выката читать нечем \(в env шага нет GH_TOKEN\/GITHUB_TOKEN/);
    expect(r.code).toBe(0);
  });

  it('GITHUB_TOKEN тоже годится', () => {
    const r = runWait({ GITHUB_TOKEN: 'ghs_other' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('behind', []),
    }, { token: false });
    expect(r.code).toBe(0);
    expect(github(r).every((c) => c.auth)).toBe(true);
  });

  it('каждый запрос к GitHub — с токеном', () => {
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('behind', []),
    });
    expect(github(r).length).toBeGreaterThan(0);
    expect(github(r).every((c) => c.auth)).toBe(true);
  });

  it('по умолчанию не чаще раза в минуту: четыре попытки подряд — один опрос записи и одно сравнение', () => {
    const env: Record<string, string> = { ATTEMPTS: '4' };
    const fake = {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'app/page.tsx' }]),
      'version.json': version(PUSH - 60),
    };
    const r = runWait({ ...env, GH_EVERY: '' }, fake);
    // GH_EVERY пустой — умолчание скрипта (60 с); попытки идут без паузы.
    expect(deploymentCalls(r)).toHaveLength(1);
    expect(compareCalls(r)).toHaveLength(1);
    expect(r.calls.filter((c) => c.url.endsWith('/version.json'))).toHaveLength(4);
  });
});

describe('ожидание читает то окружение, куда пишет deploy.yml', () => {
  it('environment запроса — тот же, что у записи выката', () => {
    const deploy = loadWorkflow('.github/workflows/deploy.yml');
    const env = deploy.env?.DEPLOY_ENVIRONMENT;
    expect(env, 'deploy.yml не объявляет DEPLOY_ENVIRONMENT').toBeTruthy();
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('behind', []),
    });
    const q = deploymentCalls(r)[0]?.url ?? '';
    expect(new URL(q).searchParams.get('environment')).toBe(env);
    expect(new URL(q).pathname).toBe('/repos/tourhabk-ui/pos/deployments');
  });
});
