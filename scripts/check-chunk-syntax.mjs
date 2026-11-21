#!/usr/bin/env node
/**
 * Синтаксис собранных кусков сайта — тот, что прочтёт старый браузер.
 *
 * Повод — экран в машине, 21.11: старый Chrome на Android, главная падала
 * в «Страница не догрузилась», в ловушке ошибок — ChunkLoadError
 * «(missing: …/chunks/54449-….js)». Так webpack сообщает о куске, который
 * скачался, но не исполнился: браузер не разобрал его синтаксис. Код
 * приложения Next понижает до своей цели (browserslist в проекте не задан —
 * по умолчанию Chrome 64), а пакеты из node_modules отдаёт как есть: в
 * кусках главной стояли `??`, `?.` и статические блоки классов framer-motion.
 *
 * Скрипт разбирает парсером acorn с ecmaVersion цели КАЖДЫЙ кусок
 * `.next/static/chunks` — и те, что подгружаются по требованию (их нет в
 * манифесте маршрутов). Правила:
 *   - кусок не разобран — красный, если он не из пакета, записанного в
 *     KNOWN_UNLOWERED с причиной;
 *   - куски каркаса, главной, SOS и экранов ошибок (REQUIRED_ROUTES, по
 *     `app-build-manifest.json`) обязаны разбираться без исключений;
 *   - запись KNOWN_UNLOWERED, под которую не попал ни один неразобранный
 *     кусок, — красный: запись устарела, её снимают;
 *   - маршрута нет в манифесте, файла нет на диске, манифест не прочитан,
 *     кусков ноль — «не смог проверить», тоже красный (CLAUDE.md §4.0).
 *
 * Запуск: `node scripts/check-chunk-syntax.mjs [каталог .next]` — шаг CI
 * после сборки. Сторож — tests/unit/chunk-syntax-check.test.ts.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

/**
 * Цель: Chrome 64 — то, до чего Next понижает код приложения, пока в проекте
 * нет browserslist. ES2018: без `?.`, `??`, `catch` без параметра, полей и
 * статических блоков классов.
 */
export const TARGET = { ecmaVersion: 2018, browser: 'Chrome 64' };

/**
 * Маршруты, которые обязаны открываться в старом браузере: каркас (он есть
 * на каждой странице), главная, экран SOS с ретранслятором и экраны ошибок.
 * Имена — ключи `app-build-manifest.json`.
 */
export const REQUIRED_ROUTES = [
  '/layout',
  '/page',
  '/sos/page',
  '/sos/relay/page',
  '/sos/error',
  '/error',
  '/global-error',
];

/**
 * Пакеты, чьи куски сборка не понижает, — с причиной. Узнаются по строке в
 * самом куске: имён модулей в собранном коде нет. Метка — строка, которая
 * есть только в коде библиотеки: слово «maplibre» есть и в нашем коде (путь к
 * воркеру, lib/map/maplibre-worker.ts), и по нему кусок приложения с новым
 * синтаксисом сошёл бы за кусок карты (ревью безопасности #3644). Что метки
 * нет в нашем коде, держит сторож.
 */
export const KNOWN_UNLOWERED = [
  {
    pkg: 'maplibre-gl',
    marker: /maplibregl-ctrl|mapbox\/mapbox-gl-js\/issues/,
    reason: 'MapLibre 6 поднимает воркер модулем из public/vendor — старый браузер его '
      + 'не поднимет и с пониженным главным куском (next.config.js, transpilePackages). '
      + 'Куски грузятся только на экранах с картой; отказ импорта VedarMap ловит и '
      + 'говорит «Карта не загрузилась.».',
  },
];

/** Ошибка разбора или null. */
export function syntaxError(code, ecmaVersion = TARGET.ecmaVersion) {
  try {
    parse(code, { ecmaVersion, sourceType: 'script', allowHashBang: true });
    return null;
  } catch (err) {
    const pos = typeof err?.pos === 'number' ? err.pos : null;
    const near = pos === null ? '' : code.slice(Math.max(0, pos - 40), pos + 40).replace(/\s+/g, ' ');
    return { message: err instanceof Error ? err.message : String(err), near };
  }
}

/**
 * Проверка сборки.
 * @param {object} args
 * @param {Record<string, string[]> | null} args.appPages — `pages` из app-build-manifest
 * @param {string[]} args.rootFiles — общие куски (`rootMainFiles`, `polyfillFiles`)
 * @param {string[]} args.allFiles — все `.js` из static/chunks, путями от каталога сборки
 * @param {(file: string) => string | null} args.read — текст куска или null, если файла нет
 * @param {string[]} [args.routes]
 * @param {{pkg: string, marker: RegExp, reason: string}[]} [args.known]
 * @param {number} [args.ecmaVersion]
 */
export function checkChunks({
  appPages, rootFiles, allFiles, read,
  routes = REQUIRED_ROUTES, known = KNOWN_UNLOWERED, ecmaVersion = TARGET.ecmaVersion,
}) {
  const unchecked = [];
  const bad = [];
  const allowed = [];
  const checked = [];

  if (!appPages) unchecked.push('манифест app-build-manifest.json не прочитан');

  const required = new Map();
  for (const f of rootFiles) required.set(f, new Set(['(общие куски)']));
  for (const route of appPages ? routes : []) {
    const files = appPages[route];
    if (!Array.isArray(files) || files.length === 0) {
      unchecked.push(`маршрута ${route} нет в манифесте сборки`);
      continue;
    }
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      if (!required.has(f)) required.set(f, new Set());
      required.get(f).add(route);
    }
  }

  const used = new Set();
  const files = [...new Set([...allFiles, ...required.keys()])].sort();
  for (const file of files) {
    const code = read(file);
    if (code === null) { unchecked.push(`файла ${file} нет на диске`); continue; }
    checked.push(file);
    const error = syntaxError(code, ecmaVersion);
    if (!error) continue;
    const inRoutes = required.has(file) ? [...required.get(file)].sort() : [];
    const pkg = known.find((k) => k.marker.test(code));
    if (pkg && inRoutes.length === 0) {
      used.add(pkg.pkg);
      allowed.push({ file, pkg: pkg.pkg });
      continue;
    }
    bad.push({ file, routes: inRoutes, pkg: pkg?.pkg ?? null, ...error });
  }

  if (checked.length === 0) unchecked.push('ни одного куска не проверено');
  const stale = known.filter((k) => !used.has(k.pkg)).map((k) => k.pkg);

  return { checked, bad, allowed, stale, unchecked };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`[chunk-syntax] не прочитан ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function listChunks(nextDir) {
  const root = join(nextDir, 'static/chunks');
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) out.push(relative(nextDir, p).split('\\').join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Проверка каталога `.next`; возвращает код выхода. */
export function runCheck(nextDir) {
  const app = readJson(join(nextDir, 'app-build-manifest.json'));
  const build = readJson(join(nextDir, 'build-manifest.json'));
  const rootFiles = [...(build?.rootMainFiles ?? []), ...(build?.polyfillFiles ?? [])].filter((f) => f.endsWith('.js'));
  const result = checkChunks({
    appPages: app?.pages ?? null,
    rootFiles,
    allFiles: listChunks(nextDir),
    read: (f) => {
      const p = join(nextDir, f);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
  });
  if (!build) result.unchecked.push('манифест build-manifest.json не прочитан');

  console.log(`Цель: ${TARGET.browser} (ES${TARGET.ecmaVersion}). Без исключений: ${REQUIRED_ROUTES.join(', ')}.`);
  console.log(`Проверено кусков: ${result.checked.length}.`);
  for (const b of result.bad) {
    const where = b.routes.length ? ` [${b.routes.join(', ')}]` : '';
    const pkg = b.pkg ? ` (${b.pkg} — в обязательном маршруте исключения нет)` : '';
    console.log(`НЕ РАЗБИРАЕТСЯ ${b.file}${where}${pkg}: ${b.message}`);
    if (b.near) console.log(`  рядом: …${b.near}…`);
  }
  for (const a of result.allowed) console.log(`исключение ${a.pkg}: ${a.file}`);
  for (const s of result.stale) console.log(`ЗАПИСЬ УСТАРЕЛА: ${s} в KNOWN_UNLOWERED — его куски разбираются, запись снять`);
  for (const u of result.unchecked) console.log(`НЕ СМОГ ПРОВЕРИТЬ: ${u}`);

  const failed = result.bad.length > 0 || result.stale.length > 0 || result.unchecked.length > 0;
  console.log(failed ? 'Итог: красный.' : `Итог: куски читаются в ${TARGET.browser}, кроме записанных исключений.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCheck(resolve(process.argv[2] ?? '.next')));
}
