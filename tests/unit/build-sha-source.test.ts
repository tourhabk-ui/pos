/**
 * Сторож: откуда сборка берёт sha коммита и что она говорит, когда не берёт.
 *
 * ── #1762, 10.09 ───────────────────────────────────────────────────────────
 *
 * Маркер прода второй месяц отвечает `commit: unknown, reason: no_git_head` —
 * `.git` не доезжает до сборки вовсе (контекст Timeweb — архив, а не клон), и
 * обе прежние починки (разыменование ссылки 23.08, форма `.git/*` 29.08) тут
 * ни при чём: чинить нечего, файла нет.
 *
 * Цена перестала быть теоретической: без sha у проверки деплоя остаётся один
 * признак «это образ моего пуша» — `built_at`, а он ложный. Образ ПРЕДЫДУЩЕГО
 * коммита, собранный после нашего пуша, тоже новее пуша, и дважды за час
 * старый контейнер сошёл за свежий.
 *
 * Отсюда второй источник sha — окружение сборки, — и три вещи, которые он
 * обязан соблюдать и которые держит этот файл:
 *   1. окружение спрашивается ПЕРВЫМ (переменная переживает архив без .git);
 *   2. имена ЗАКРЫТЫ списком — «что-нибудь похожее на sha» однажды запишет в
 *      маркер чужой ключ из сорока hex;
 *   3. список объявлен в Dockerfile как ARG: необъявленный --build-arg Docker
 *      игнорирует МОЛЧА, и починка, не доехавшая до сборки, неотличима от её
 *      отсутствия.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { SHA_ENV_NAMES as RUNTIME_NAMES, declaredEnvNamesSet, shaShapedEnvNames } from '@/lib/build/commit-sha';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const require_ = createRequire(import.meta.url);
const { resolveBuildSha, SHA_ENV_NAMES } = require_(join(process.cwd(), 'scripts/write-version.js')) as {
  resolveBuildSha: (
    env?: NodeJS.ProcessEnv,
    gitDir?: string,
  ) => { sha: string | null; reason: string; source: string | null; envProbe: string[]; envMalformed: string[] };
  SHA_ENV_NAMES: string[];
};

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const SHA_40 = 'a'.repeat(40);

/** Каталог `.git` с нужными файлами — чтобы проверять приоритет источников. */
function mkGit(files: Record<string, string>): string {
  const git = join(mkdtempSync(join(tmpdir(), 'bsha-')), '.git');
  mkdirSync(git, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(git, rel), body);
  return git;
}
const NO_GIT = join(mkdtempSync(join(tmpdir(), 'bsha-')), 'нет-такого');

describe('sha сборки: окружение — первый источник, .git — второй', () => {
  it('переменная берётся, когда .git недоступен (случай Timeweb)', () => {
    const res = resolveBuildSha({ BUILD_COMMIT_SHA: SHA_40 }, NO_GIT);
    expect(res).toMatchObject({ sha: SHA_40, reason: 'ok', source: 'env:BUILD_COMMIT_SHA' });
  });

  it('переменная ПЕРЕВЕШИВАЕТ .git: она описывает то, что просили собрать', () => {
    const git = mkGit({ HEAD: `${'c'.repeat(40)}\n` });
    const res = resolveBuildSha({ BUILD_COMMIT_SHA: SHA_40 }, git);
    expect(res.sha).toBe(SHA_40);
    expect(res.source).toBe('env:BUILD_COMMIT_SHA');
  });

  it('без переменных остаётся прежний путь через .git — регрессии нет', () => {
    const git = mkGit({ HEAD: `${'c'.repeat(40)}\n` });
    expect(resolveBuildSha({}, git)).toMatchObject({ sha: 'c'.repeat(40), reason: 'ok', source: 'git' });
  });

  it('порядок доверия соблюдается: наше имя раньше чужих', () => {
    const res = resolveBuildSha({ GITHUB_SHA: 'b'.repeat(40), BUILD_COMMIT_SHA: SHA_40 }, NO_GIT);
    expect(res.source).toBe('env:BUILD_COMMIT_SHA');
  });

  it('короткий sha провайдера — тоже ответ (проверка деплоя сверяет 7 знаков)', () => {
    expect(resolveBuildSha({ SOURCE_COMMIT: '1a2b3c4' }, NO_GIT)).toMatchObject({
      sha: '1a2b3c4',
      source: 'env:SOURCE_COMMIT',
    });
  });

  it('чужое имя со sha внутри не берётся: список источников закрыт', () => {
    // Сорок hex — форма не только коммита, но и многих ключей. Брать «что-то
    // похожее» значит однажды записать в публичный маркер секрет.
    const res = resolveBuildSha({ SOME_OTHER_HASH: SHA_40 }, NO_GIT);
    expect(res.sha).toBeNull();
    expect(res.source).toBeNull();
  });
});

describe('sha сборки: «не знаю» и «задано неверно» — разные состояния', () => {
  it('ничего не нашлось — прежняя причина .git, source=null, sha не выдуман', () => {
    const res = resolveBuildSha({}, NO_GIT);
    expect(res).toMatchObject({ sha: null, reason: 'no_git_head', source: null });
  });

  it('имя задано, значение не sha — имя попадает в env_malformed, а не глохнет', () => {
    // Пустой catch превращает поломку в «данных нет» (§4.0). Здесь то же:
    // молча пропустить кривое значение значит звать владельца чинить панель
    // там, где чинить надо значение.
    const res = resolveBuildSha({ BUILD_COMMIT_SHA: '$COMMIT_SHA' }, NO_GIT);
    expect(res.sha).toBeNull();
    expect(res.envMalformed).toContain('BUILD_COMMIT_SHA');
  });

  it('кривое значение не мешает следующему имени и не мешает .git', () => {
    const git = mkGit({ HEAD: `${'c'.repeat(40)}\n` });
    const res = resolveBuildSha({ BUILD_COMMIT_SHA: 'не-sha' }, git);
    expect(res.sha).toBe('c'.repeat(40));
    expect(res.envMalformed).toEqual(['BUILD_COMMIT_SHA']);
  });

  it('env_probe говорит, что вообще ДОШЛО до сборки — пустой список тоже ответ', () => {
    expect(resolveBuildSha({}, NO_GIT).envProbe).toEqual([]);
    expect(resolveBuildSha({ GIT_COMMIT: 'мусор' }, NO_GIT).envProbe).toEqual(['GIT_COMMIT']);
  });

  it('диагностика уходит в маркер только при неудаче и НЕ несёт значений', () => {
    const SRC = readFileSync(join(ROOT, 'scripts/write-version.js'), 'utf8');
    const marker = SRC.slice(SRC.indexOf("'public/version.json'"), SRC.indexOf('console.log'));
    expect(marker).toMatch(/source,/);
    expect(marker, 'env_probe при удаче — шум на публичном адресе').toMatch(
      /\.\.\.\(sha \? \{\} : \{ env_probe: envProbe, env_malformed: envMalformed \}\)/,
    );
  });
});

describe('список имён объявлен там, где Docker его увидит', () => {
  it('каждое имя объявлено ARG до вызова скрипта — иначе оно не дойдёт', () => {
    // Необъявленный --build-arg Docker игнорирует молча: переменная просто не
    // появится внутри RUN, и «починили» будет неотличимо от «не починили».
    const runAt = DOCKERFILE.indexOf('RUN node scripts/write-version.js');
    expect(runAt, 'вызов скрипта в Dockerfile не найден').toBeGreaterThan(-1);
    const before = DOCKERFILE.slice(0, runAt);
    for (const name of SHA_ENV_NAMES) {
      expect(before, `ARG ${name} не объявлен до write-version.js`).toMatch(
        new RegExp(`^ARG ${name}$`, 'm'),
      );
    }
  });

  it('списки скрипта и рантайма совпадают — дубль есть, расхождения быть не должно', () => {
    // Дубль намеренный: скрипт исполняется в образе простым CJS и импортировать
    // из lib/ не может. Значит паритет держится сторожем, как у node-версии.
    expect([...RUNTIME_NAMES]).toEqual(SHA_ENV_NAMES);
  });
});

describe('рантайм-разведка имён: имена наружу, значения — никогда', () => {
  it('находит sha под известным именем и отдаёт семь знаков, а не значение', () => {
    const [first] = shaShapedEnvNames({ BUILD_COMMIT_SHA: SHA_40 });
    expect(first).toEqual({ name: 'BUILD_COMMIT_SHA', prefix: 'aaaaaaa', length: 40, declared: true });
  });

  it('находит НЕизвестное имя с полным sha — ради этого проба и заведена', () => {
    const found = shaShapedEnvNames({ TIMEWEB_DEPLOY_COMMIT: SHA_40 });
    expect(found.map((s) => s.name)).toEqual(['TIMEWEB_DEPLOY_COMMIT']);
    expect(found[0].declared).toBe(false);
  });

  it('секретообразные имена пропускаются: 40 hex — форма и ключа тоже', () => {
    const env = { SOME_API_KEY: SHA_40, WEBHOOK_SECRET: SHA_40, DATABASE_URL: SHA_40 };
    expect(shaShapedEnvNames(env)).toEqual([]);
  });

  it('незнакомому имени короткого sha мало — иначе в список попадёт всё подряд', () => {
    expect(shaShapedEnvNames({ SOMETHING: '1a2b3c4' })).toEqual([]);
    expect(shaShapedEnvNames({ GIT_SHA: '1a2b3c4' })).toHaveLength(1);
  });

  it('заданное и заданное неверно различаются', () => {
    const res = declaredEnvNamesSet({ GIT_SHA: SHA_40, COMMIT_SHA: 'не-sha' });
    expect(res).toEqual({ ok: ['GIT_SHA'], malformed: ['COMMIT_SHA'] });
  });
});

describe('проба прода: спросить окружение, не заглядывая в панель', () => {
  const ROUTE = readFileSync(join(ROOT, 'app/api/cron/build-sha-probe/route.ts'), 'utf8');

  it('закрыта CRON_SECRET — имена переменных не для публики', () => {
    expect(ROUTE).toMatch(/getCronSecret\(request\)/);
    expect(ROUTE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
    expect(ROUTE).toMatch(/status: 401/);
  });

  it('значения переменных не читаются напрямую — только через lib/build', () => {
    // Единственный путь наружу — shaShapedEnvNames/declaredEnvNamesSet, они
    // отдают имена и семь знаков. Прямое чтение process.env[...] в ответе
    // было бы утечкой.
    expect(ROUTE).not.toMatch(/process\.env\[/);
    expect(ROUTE).toMatch(/from '@\/lib\/build\/commit-sha'/);
  });

  it('три исхода, и третий не равен первому (§4.0)', () => {
    for (const v of ['marker_names_commit', 'runtime_sha_found', 'no_sha_anywhere']) {
      expect(ROUTE, `нет исхода ${v}`).toContain(`'${v}'`);
    }
  });

  it('проба НЕ объявляет переменную окружения версией прода', () => {
    // Переменная описывает настройку приложения, маркер — слои образа.
    // Контейнер, перезапущенный со свежей переменной на старом образе, назвал
    // бы чужой коммит: ровно тот дефект, ради которого всё затеяно.
    expect(ROUTE).toMatch(/НЕ версия прода|не версия прода|НЕ версией прода/);
    expect(ROUTE).toMatch(/runtime_disagrees_with_marker/);
  });

  it('объявлена ручной в реестре запускающих — молчание не ответ', () => {
    expect(MANUAL_ENDPOINTS['build-sha-probe']).toMatchObject({ kind: 'manual', writes: false });
  });
});
