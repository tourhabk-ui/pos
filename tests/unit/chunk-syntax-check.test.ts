/**
 * Куски сборки каркаса, главной и SOS читаются старым браузером (экран в
 * машине, 21.11).
 *
 * Старый Chrome на Android открыл главную и получил «Страница не
 * догрузилась»: в ловушке ошибок — ChunkLoadError «(missing: …)», то есть кусок
 * скачался, но браузер не разобрал его синтаксис. Next понижает до Chrome 64
 * только код приложения; пакеты из node_modules (framer-motion) шли в кусках
 * как есть — с `??`, `?.` и статическими блоками классов.
 *
 * Сторож держит:
 *   - разбор куска на цели: синтаксис новее ES2018 — ошибка, ES2018 — нет;
 *   - проверку сборки: неразобранный кусок — красный с маршрутом и местом,
 *     включая куски по требованию вне манифеста; кусок пакета из
 *     KNOWN_UNLOWERED — исключение, но не в каркасе, главной и SOS; запись без
 *     неразобранного куска устарела — красный; маршрута нет в манифесте,
 *     файла нет, манифест не прочитан — «не смог проверить», тоже красный —
 *     вызовом и запуском скрипта на подложенной сборке;
 *   - обязательные маршруты — это файлы, которые есть в app/;
 *   - шаг CI запускает проверку после сборки в том же job;
 *   - пакеты анимации понижаются сборкой (transpilePackages next.config.js)
 *     и стоят в node_modules.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
// @ts-expect-error — скрипт на .mjs без деклараций типов
import { syntaxError, checkChunks, REQUIRED_ROUTES, TARGET, KNOWN_UNLOWERED } from '../../scripts/check-chunk-syntax.mjs';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/check-chunk-syntax.mjs');

const OLD_OK = 'var a = {...{b: 1}}; async function f() { for await (const x of []) {} } /(?<y>\\d)/s.test("1");';
const NEWER = {
  nullish: 'var a = null ?? 1;',
  optional: 'var a = {}; a?.b;',
  optionalCatch: 'try { f(); } catch { g(); }',
  staticBlock: 'class A { static { this.x = 1; } }',
  classField: 'class A { x = 1; }',
};

describe('разбор куска на цели Chrome 64 (ES2018)', () => {
  it('цель — ES2018', () => {
    expect(TARGET.ecmaVersion).toBe(2018);
  });

  it('синтаксис ES2018 разбирается', () => {
    expect(syntaxError(OLD_OK)).toBeNull();
  });

  for (const [name, code] of Object.entries(NEWER)) {
    it(`${name} — ошибка с местом`, () => {
      const err = syntaxError(code);
      expect(err).not.toBeNull();
      expect(typeof err.message).toBe('string');
      expect(err.near.length).toBeGreaterThan(0);
      expect(syntaxError(code, 2022)).toBeNull();
    });
  }
});

describe('проверка сборки', () => {
  const pages = {
    '/layout': ['static/chunks/a.js', 'static/css/x.css'],
    '/page': ['static/chunks/a.js', 'static/chunks/home.js'],
    '/map/page': ['static/chunks/map.js'],
  };
  const files: Record<string, string> = {
    'static/chunks/a.js': OLD_OK,
    'static/chunks/home.js': NEWER.staticBlock,
    'static/chunks/map.js': NEWER.optional,
    'static/chunks/lazy-map.js': `/* maplibre */ ${NEWER.nullish}`,
    'static/chunks/lazy-other.js': NEWER.nullish,
    'static/chunks/main.js': OLD_OK,
  };
  const read = (f: string) => files[f] ?? null;
  const known = [{ pkg: 'maplibre-gl', marker: /maplibre/, reason: 'тест' }];
  const base = { appPages: pages, rootFiles: ['static/chunks/main.js'], read, known, routes: ['/layout', '/page'] };

  it('плохой кусок обязательного маршрута — красный, назван маршрут', () => {
    const r = checkChunks({ ...base, allFiles: ['static/chunks/a.js', 'static/chunks/home.js', 'static/chunks/lazy-map.js'] });
    expect(r.unchecked).toEqual([]);
    expect(r.bad.map((b: { file: string; routes: string[] }) => [b.file, b.routes])).toEqual([['static/chunks/home.js', ['/page']]]);
    expect(r.checked).toEqual(['static/chunks/a.js', 'static/chunks/home.js', 'static/chunks/lazy-map.js', 'static/chunks/main.js']);
  });

  it('кусок по требованию вне манифеста тоже судится', () => {
    const r = checkChunks({ ...base, allFiles: ['static/chunks/lazy-other.js', 'static/chunks/lazy-map.js'] });
    expect(r.bad.map((b: { file: string }) => b.file)).toEqual(['static/chunks/home.js', 'static/chunks/lazy-other.js']);
  });

  it('кусок записанного пакета — исключение, а не провал', () => {
    const r = checkChunks({ ...base, routes: ['/layout'], allFiles: ['static/chunks/lazy-map.js'] });
    expect(r.bad).toEqual([]);
    expect(r.allowed).toEqual([{ file: 'static/chunks/lazy-map.js', pkg: 'maplibre-gl' }]);
    expect(r.stale).toEqual([]);
  });

  it('в обязательном маршруте исключения нет', () => {
    const r = checkChunks({
      ...base, routes: ['/page'], allFiles: [],
      appPages: { '/page': ['static/chunks/lazy-map.js'] },
    });
    expect(r.bad.map((b: { file: string; pkg: string | null }) => [b.file, b.pkg])).toEqual([['static/chunks/lazy-map.js', 'maplibre-gl']]);
  });

  it('запись без неразобранного куска устарела — красный', () => {
    const r = checkChunks({ ...base, routes: ['/layout'], allFiles: ['static/chunks/a.js'] });
    expect(r.stale).toEqual(['maplibre-gl']);
  });

  it('маршрута нет в манифесте — «не смог проверить»', () => {
    const r = checkChunks({ ...base, routes: ['/layout', '/sos/page'], allFiles: ['static/chunks/lazy-map.js'] });
    expect(r.unchecked).toEqual(['маршрута /sos/page нет в манифесте сборки']);
  });

  it('файла нет на диске — «не смог проверить»', () => {
    const r = checkChunks({ ...base, rootFiles: [], routes: ['/layout'], appPages: { '/layout': ['static/chunks/gone.js'] }, allFiles: [] });
    expect(r.checked).toEqual([]);
    expect(r.unchecked).toEqual(['файла static/chunks/gone.js нет на диске', 'ни одного куска не проверено']);
  });

  it('манифест не прочитан — «не смог проверить»', () => {
    const r = checkChunks({ ...base, appPages: null, allFiles: ['static/chunks/lazy-map.js'] });
    expect(r.unchecked).toEqual(['манифест app-build-manifest.json не прочитан']);
  });
});

/** Подложенный каталог `.next` с манифестами и кусками. */
function fakeBuild(home: string, opts: { dropRoute?: string; noMap?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'chunk-syntax-'));
  mkdirSync(join(dir, 'static/chunks/app'), { recursive: true });
  const pages: Record<string, string[]> = {};
  for (const r of REQUIRED_ROUTES) if (r !== opts.dropRoute) pages[r] = ['static/chunks/common.js'];
  if (opts.dropRoute !== '/page') pages['/page'] = ['static/chunks/common.js', 'static/chunks/app/home.js'];
  writeFileSync(join(dir, 'app-build-manifest.json'), JSON.stringify({ pages }));
  writeFileSync(join(dir, 'build-manifest.json'), JSON.stringify({ rootMainFiles: ['static/chunks/main.js'], polyfillFiles: ['static/chunks/polyfills.js'] }));
  writeFileSync(join(dir, 'static/chunks/common.js'), OLD_OK);
  writeFileSync(join(dir, 'static/chunks/main.js'), OLD_OK);
  writeFileSync(join(dir, 'static/chunks/polyfills.js'), 'var x = 1;');
  writeFileSync(join(dir, 'static/chunks/app/home.js'), home);
  if (!opts.noMap) writeFileSync(join(dir, 'static/chunks/37ccfc09.js'), `var s="maplibre"; ${NEWER.nullish}`);
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('скрипт на подложенной сборке', () => {
  it('всё разбирается, карта — исключением: выход 0', () => {
    const r = run(fakeBuild(OLD_OK));
    expect(r.out).toContain('исключение maplibre-gl: static/chunks/37ccfc09.js');
    expect(r.code).toBe(0);
  });

  it('кусок главной со статическим блоком — выход 1, назван файл и маршрут', () => {
    const r = run(fakeBuild(NEWER.staticBlock));
    expect(r.code).toBe(1);
    expect(r.out).toContain('НЕ РАЗБИРАЕТСЯ static/chunks/app/home.js [/page]');
  });

  it('обязательного маршрута нет в сборке — выход 1', () => {
    const r = run(fakeBuild(OLD_OK, { dropRoute: '/sos/page' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('НЕ СМОГ ПРОВЕРИТЬ: маршрута /sos/page нет в манифесте сборки');
  });

  it('кусков карты больше нет — запись устарела, выход 1', () => {
    const r = run(fakeBuild(OLD_OK, { noMap: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('ЗАПИСЬ УСТАРЕЛА: maplibre-gl');
  });

  it('каталога сборки нет — выход 1', () => {
    const r = run(join(tmpdir(), 'chunk-syntax-nothing-here'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('НЕ СМОГ ПРОВЕРИТЬ');
  });
});

describe('исключения названы с причиной', () => {
  it('у каждой записи KNOWN_UNLOWERED есть пакет в node_modules и причина', () => {
    for (const k of KNOWN_UNLOWERED as { pkg: string; reason: string }[]) {
      expect(existsSync(join(ROOT, 'node_modules', k.pkg, 'package.json')), k.pkg).toBe(true);
      expect(k.reason.length).toBeGreaterThan(40);
    }
  });

  it('пакет исключения не понижается сборкой — иначе запись лишняя', () => {
    const require = createRequire(import.meta.url);
    const config = require(join(ROOT, 'next.config.js')) as { transpilePackages?: string[] };
    for (const k of KNOWN_UNLOWERED as { pkg: string }[]) expect(config.transpilePackages ?? []).not.toContain(k.pkg);
  });
});

describe('обязательные маршруты — настоящие файлы app/', () => {
  for (const route of REQUIRED_ROUTES) {
    it(route, () => {
      const base = join(ROOT, 'app', route);
      expect(existsSync(`${base}.tsx`) || existsSync(`${base}.ts`), `${route}: нет app${route}.tsx`).toBe(true);
    });
  }
});

describe('шаг CI', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const steps = ci.split(/\n\s{6}- name: /);
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s));

  it('проверка идёт после сборки в том же job и раньше тестов', () => {
    const build = at(/^Build \(Next\.js\)/);
    const check = at(/node scripts\/check-chunk-syntax\.mjs/);
    const tests = at(/run: npx vitest run\s*$/m);
    expect(build).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(build);
    expect(tests).toBeGreaterThan(check);
    const between = steps.slice(build, check + 1).join('\n');
    expect(between).not.toMatch(/\n\s{2}[a-z][\w-]*:\n\s{4}(name|runs-on):/);
  });
});

describe('пакеты анимации понижает сборка', () => {
  const require = createRequire(import.meta.url);
  const config = require(join(ROOT, 'next.config.js')) as { transpilePackages?: string[] };
  const MOTION = ['framer-motion', 'motion-dom', 'motion-utils'];

  it('transpilePackages называет их', () => {
    for (const p of MOTION) expect(config.transpilePackages ?? []).toContain(p);
  });

  it('каждый пакет из transpilePackages стоит в node_modules', () => {
    for (const p of config.transpilePackages ?? []) {
      expect(existsSync(join(ROOT, 'node_modules', p, 'package.json')), `${p} не установлен`).toBe(true);
    }
  });
});
