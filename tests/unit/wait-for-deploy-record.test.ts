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
 *  - усечённый, пустой список файлов и переименование из образа — не «вне
 *    образа»; файлы, которые в образе есть (migrations/, public/, start.js…),
 *    — тоже не «вне»;
 *  - CODE_PATHS судит запись выката; окно по времени — только запасной путь,
 *    когда запись не прочитана (замечание ревью 15.10: стоя ДО записи, окно
 *    отвечало «прод уже несёт» на коммит в lib/places, которого в записи нет);
 *  - срок ожидания — на часах: накладные расходы попыток окно не растягивают;
 *  - каждый workflow, который ждёт, может прочитать запись: токен у шага и
 *    права `deployments`/`contents` у джоба.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
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
# Подложенные часы: каждый вопрос сайту стоит FAKE_CURL_COST секунд.
if [ -n "\${FAKE_CLOCK:-}" ] && [ "$key" = version ]; then
  echo $(( $(cat "$FAKE_CLOCK") + \${FAKE_CURL_COST:-0} )) > "$FAKE_CLOCK"
fi
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

// Часы и пауза: без FAKE_CLOCK — настоящие (первый элемент PATH — заглушки,
// он и снимается); с ним `date +%s` читает файл, а `sleep N` двигает его.
const DATE_STUB = `#!/usr/bin/env bash
if [ -n "\${FAKE_CLOCK:-}" ] && [ "$*" = "+%s" ]; then cat "$FAKE_CLOCK"; exit 0; fi
PATH="\${PATH#*:}" exec date "$@"
`;
const SLEEP_STUB = `#!/usr/bin/env bash
if [ -n "\${FAKE_CLOCK:-}" ]; then echo $(( $(cat "$FAKE_CLOCK") + $1 )) > "$FAKE_CLOCK"; exit 0; fi
PATH="\${PATH#*:}" exec sleep "$@"
`;

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'wait-record-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['curl', CURL_STUB], ['date', DATE_STUB], ['sleep', SLEEP_STUB]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

interface Call { url: string; auth: boolean }
interface Run { code: number; out: string; calls: Call[]; clock: number | null }

type Fake = Record<string, string>;

interface WaitOpts {
  token?: boolean;
  /** Каталог запуска — git-репозиторий для окна CODE_PATHS. */
  cwd?: string;
  /** Подложенные часы: начальное время, epoch. */
  clock?: number;
}

function runWait(env: Record<string, string>, fake: Fake, opts: WaitOpts = {}): Run {
  const fakeDir = mkdtempSync(join(work, 'fake-'));
  for (const [f, body] of Object.entries(fake)) writeFileSync(join(fakeDir, f), body);
  const clockFile = join(fakeDir, 'clock');
  if (opts.clock !== undefined) writeFileSync(clockFile, String(opts.clock));
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
    ...(opts.clock !== undefined ? { FAKE_CLOCK: clockFile } : {}),
    ...env,
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT], { cwd: opts.cwd ?? fakeDir, env: fullEnv, encoding: 'utf-8', stdio: 'pipe' });
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
  const clock = opts.clock !== undefined ? Number(readFileSync(clockFile, 'utf-8')) : null;
  return { code, out, calls, clock };
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

  it('пустой список файлов при ahead — не «изменений нет», а «не доказать»', () => {
    // Пустой коммит и «GitHub не посчитал дифф» снаружи неразличимы.
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', []),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/сравнение назвало ноль файлов при ahead/);
    expect(r.out).not.toMatch(/прод уже несёт/);
  });

  it('файл без имени — не «вне образа» и не «вне CODE_PATHS»', () => {
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: 'lib/places' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': JSON.stringify({ status: 'ahead', files: [{ filename: '.github/x.json' }, { status: 'modified' }] }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/в сравнении файл без имени/);
  });

  // Список «вне образа» закреплён исполнением (замечание ревью 15.10: его
  // расширение до migrations/ и public/ проходило сторожей зелёным). Эти
  // файлы в образе ЕСТЬ: runner-стадия Dockerfile копирует public/,
  // migrations/, start.js и scripts/migrate-standalone.js, а package.json,
  // next.config.js и Dockerfile задают саму сборку.
  it.each([
    'migrations/1300_x.sql',
    'public/x.png',
    'start.js',
    'scripts/migrate-standalone.js',
    'package.json',
    'next.config.js',
    'Dockerfile',
  ])('%s рядом с маркером — файл образа, ждём', (file) => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: '.github/triggers/prod-check.json' }, { filename: file }]),
      'version.json': FAR_FUTURE,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`есть файлы образа: ${file}`);
  });
});

// ── CODE_PATHS: запись главнее окна (замечание ревью 15.10, блокирующее) ──
//
// Окно «код эндпоинта не менялся 60 мин» стояло ДО записи и решало по
// времени. Без автодеплоя его посылка ложна: CI на main красный или выкат
// упал — код не выкатывается вовсе, а путь CI 36 + сборка 26 длиннее часа.
// Ревьюер воспроизвёл: коммит в lib/places 90 минут назад, которого в записи
// нет, — и place-coords (REQUIRE_FRESH, apply пишет координаты в базу прода)
// получал «прод уже несёт его», exit 0, не спросив GitHub ни разу.
describe('CODE_PATHS судит запись выката; окно по времени — только запасной путь', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const CP = 'app/api/cron/place-coords lib/places';

  /** git-репозиторий с коммитами «N минут назад» — для окна CODE_PATHS. */
  function repoWith(commits: Array<{ file: string; minutesAgo: number }>): string {
    const dir = mkdtempSync(join(work, 'repo-'));
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync('git', ['-c', 'color.ui=false', ...args], {
        cwd: dir, encoding: 'utf-8', env: { ...process.env, ...env },
      });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    for (const c of commits) {
      mkdirSync(join(dir, c.file, '..'), { recursive: true });
      writeFileSync(join(dir, c.file), `${c.minutesAgo}\n`);
      git(['add', c.file]);
      const when = `@${NOW - c.minutesAgo * 60} +0000`;
      git(['commit', '-q', '-m', `правка ${c.file}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    }
    return dir;
  }

  // Код эндпоинта не трогали 90 минут — окно сказало бы «прод уже несёт».
  const QUIET = [
    { file: 'lib/places/a.ts', minutesAgo: 180 },
    { file: 'lib/places/b.ts', minutesAgo: 90 },
    { file: '.github/triggers/place-coords.json', minutesAgo: 2 },
  ];

  it('случай ревью: в записи нет правки lib/places — ждём и краснеем, окно не спрашивается', () => {
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: CP }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [
        { filename: 'lib/places/b.ts' },
        { filename: '.github/triggers/place-coords.json' },
      ]),
      'version.json': FAR_FUTURE,
    }, { cwd: repoWith(QUIET) });
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/не менялся 6\d мин/);
    expect(r.out).toMatch(/код эндпоинта \(app\/api\/cron\/place-coords lib\/places\) судит запись выката/);
    expect(r.out).toMatch(/последняя запись выката: выкачен 1111111 \(#7\); между ним и нашим коммитом менялся код эндпоинта: lib\/places\/b\.ts/);
    expect(github(r).length).toBeGreaterThan(0);
  });

  it('переименование из CODE_PATHS наружу — код эндпоинта менялся', () => {
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: CP }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'lib/geo/b.ts', previous_filename: 'lib/places/b.ts' }]),
    }, { cwd: repoWith(QUIET) });
    expect(r.code).toBe(1);
    // lib/geo в CODE_PATHS этого прогона нет — код эндпоинта назван по старому имени.
    expect(r.out).toMatch(/менялся код эндпоинта: lib\/places\/b\.ts[;)]/);
  });

  it('между записью и нашим коммитом код эндпоинта не менялся — в проде, по записи', () => {
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: CP }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [
        { filename: 'lib/other.ts' },
        { filename: '.github/triggers/place-coords.json' },
      ]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/между выкаченным 1111111 \(#7\) и нашим коммитом код эндпоинта не менялся \(CODE_PATHS: app\/api\/cron\/place-coords lib\/places; изменены только: \.github\/triggers\/place-coords\.json, lib\/other\.ts\)/);
  });

  it('путь, лишь начинающийся как CODE_PATHS (lib/places-x/), — не код эндпоинта', () => {
    const r = runWait({ CODE_PATHS: CP }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'lib/places-x/a.ts' }]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/код эндпоинта не менялся/);
  });

  it('без CODE_PATHS тот же дифф — файлы образа, ждём', () => {
    const r = runWait({ REQUIRE_FRESH: '1' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'lib/other.ts' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/есть файлы образа: lib\/other\.ts/);
  });

  it('запись не прочитана — окно запасным путём и словами; код не трогали дольше окна → 0', () => {
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: CP }, {
      'deployments.code': '500',
    }, { cwd: repoWith(QUIET) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/не смог прочитать запись выката \(список записей: HTTP 500/);
    expect(r.out).toMatch(/запись выката не прочитана — запасной путь по окну: код эндпоинта \(app\/api\/cron\/place-coords lib\/places\) не менялся 65 мин/);
  });

  it('запись не прочитана, код трогали 62 минуты назад — окно его ловит (прежние 60 — нет)', () => {
    // Без автодеплоя коммит 62-минутной давности ещё может ехать: CI 36 +
    // сборка 26. Окно запасного пути — не короче запаса built_at (65 мин).
    const r = runWait({ REQUIRE_FRESH: '1', CODE_PATHS: CP }, {
      'deployments.code': '500',
      'version.json': version(PUSH - 60),
    }, {
      cwd: repoWith([
        { file: 'lib/places/a.ts', minutesAgo: 180 },
        { file: 'lib/places/b.ts', minutesAgo: 62 },
        { file: '.github/triggers/place-coords.json', minutesAgo: 2 },
      ]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/код эндпоинта менялся за 65 мин — ждём сборку/);
  });

  it('без токена — окно запасным путём, к GitHub ни одного запроса', () => {
    const r = runWait({ CODE_PATHS: CP }, {}, { cwd: repoWith(QUIET), token: false });
    expect(github(r)).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/запасной путь по окну/);
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
    // Без запросов `every` истинно на пустом массиве (мутация ревью 15.10
    // «GH_AUTH только из GH_TOKEN» проходила зелёной): запросы были, и исход
    // — по записи, а не по запасному пути.
    expect(github(r).length).toBeGreaterThan(0);
    expect(github(r).every((c) => c.auth)).toBe(true);
    expect(r.out).toMatch(/в проде: последняя запись выката — 1111111 \(#7\), сравнение: behind/);
  });

  it('каждый запрос к GitHub — с токеном', () => {
    const r = runWait({}, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('behind', []),
    });
    expect(github(r).length).toBeGreaterThan(0);
    expect(github(r).every((c) => c.auth)).toBe(true);
  });

  it('по умолчанию не чаще раза в две минуты: девять попыток по 30 с — три опроса записи и одно сравнение', () => {
    // Часы подложены: 30 с пауза двигает их на 30. Опросы — до цикла (t=0),
    // на t=120 и t=240; при прежней минуте их было бы пять. Лимит токена —
    // общий на репозиторий (шапка скрипта).
    const r = runWait({ ATTEMPTS: '9', SLEEP: '30', GH_EVERY: '' }, {
      'deployments.json': deployments({ id: 7, sha: D1 }),
      'compare-1111111.json': compare('ahead', [{ filename: 'app/page.tsx' }]),
      'version.json': version(PUSH - 60),
    }, { clock: 1_000_000 });
    expect(r.calls.filter((c) => c.url.endsWith('/version.json'))).toHaveLength(9);
    expect(deploymentCalls(r)).toHaveLength(3);
    expect(compareCalls(r)).toHaveLength(1);
  });
});

// ── Срок ожидания — на часах (замечание ревью 15.10) ──────────────────────
//
// Сторож workflow-timeout-fits-wait сравнивает таймаут джоба с ATTEMPTS×SLEEP.
// У попыток свои накладные расходы (curl к сайту до 20 с, опрос GitHub), и
// 140 попыток растягивали 70 минут ещё на 2–5: джоб с потолком 75 снимала бы
// отмена — исход стёрт, как 14.09.
describe('ожидание не длиннее ATTEMPTS×SLEEP плюс одна попытка', () => {
  it('попытка стоит 10 с, бюджет 10 × 30 с — ожидание кончается в срок, а не через 400 с', () => {
    const T0 = 1_000_000;
    const r = runWait({ ATTEMPTS: '10', SLEEP: '30', FAKE_CURL_COST: '10' }, {
      'version.json': version(PUSH - 60),
    }, { token: false, clock: T0 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/своей сборки не дождались за 5 мин/);
    const tries = r.calls.filter((c) => c.url.endsWith('/version.json')).length;
    expect(tries).toBeLessThan(10);
    expect(r.clock! - T0).toBeLessThanOrEqual(10 * 30 + 10);
  });

  it('без накладных расходов — все попытки', () => {
    const r = runWait({ ATTEMPTS: '10', SLEEP: '30' }, {
      'version.json': version(PUSH - 60),
    }, { token: false, clock: 1_000_000 });
    expect(r.calls.filter((c) => c.url.endsWith('/version.json'))).toHaveLength(10);
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

// ── Связка на стороне ожидающих (замечание ревью 15.10) ───────────────────
//
// Запись читается токеном шага, и токену нужно право. Мутации ревью — убрать
// GH_TOKEN у шага ожидания prod-check, убрать `deployments: read` у
// emsd-vmon-probe — проходили все сторожа workflow зелёными: такой workflow
// тихо уходит в запасной путь с запасом 3900 с, то есть почти всегда «не
// дождались», а с REQUIRE_FRESH — красный. Сторож держит связку: каждый шаг,
// который ЗОВЁТ скрипт, несёт токен, а права его джоба названы явно и
// включают `deployments` и `contents` (compare). Блок прав обязателен:
// права токена без него — настройка репозитория, из файлов её не видно, а в
// режиме restricted `deployments` нет вовсе.
describe('каждый, кто ждёт сборку, может прочитать запись выката', () => {
  const WF_DIR = join(process.cwd(), '.github/workflows');
  type Perms = string | Record<string, string> | undefined;
  interface Job { permissions?: Perms; env?: Record<string, string>; steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
  interface Doc { permissions?: Perms; env?: Record<string, string>; jobs?: Record<string, Job> }

  /** Шаг зовёт скрипт строкой кода, а не упоминает в комментарии. */
  const calls = (run: string | undefined) =>
    (run ?? '').split('\n').some((l) => !/^\s*#/.test(l) && l.includes('scripts/wait-for-deploy.sh'));
  const TOKEN = /^\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}$/;
  const canRead = (perms: Perms, scope: string) =>
    perms === 'read-all' || perms === 'write-all'
      || (typeof perms === 'object' && perms !== null && ['read', 'write'].includes(perms[scope]));

  const waiters: Array<{ where: string; doc: Doc; job: Job; step: NonNullable<Job['steps']>[number] }> = [];
  for (const f of readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const doc = load(readFileSync(join(WF_DIR, f), 'utf-8')) as Doc;
    for (const [jn, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (calls(step.run)) waiters.push({ where: `${f} / ${jn} / ${step.name ?? '(шаг без имени)'}`, doc, job, step });
      }
    }
  }

  it('ожидающие найдены — сторож не зеленеет впустую', () => {
    expect(waiters.length).toBeGreaterThan(20);
  });

  it('у шага ожидания есть токен', () => {
    const bad = waiters
      .filter(({ doc, job, step }) => {
        const env = { ...(doc.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
        return ![env.GH_TOKEN, env.GITHUB_TOKEN].some((v) => typeof v === 'string' && TOKEN.test(v.trim()));
      })
      .map((w) => w.where);
    expect(bad, 'без токена запись не читается — ожидание тихо уходит в запасной путь').toEqual([]);
  });

  it('права джоба названы и включают deployments и contents', () => {
    const bad = waiters
      .filter(({ doc, job }) => {
        const perms = job.permissions ?? doc.permissions;
        return !canRead(perms, 'deployments') || !canRead(perms, 'contents');
      })
      .map((w) => `${w.where}: ${JSON.stringify(w.job.permissions ?? w.doc.permissions ?? null)}`);
    expect(bad, 'токен без deployments:read получает 403 на списке записей, без contents:read — на compare').toEqual([]);
  });
});
