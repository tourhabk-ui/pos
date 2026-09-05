/**
 * scripts/map-tiles/snapshot-packs.ts — снимки пакетов карты глазами MapLibre.
 *
 * Зачем (05.09). Проверка хранилища (verify-packs) знает, что файл ДОЕЗЖАЕТ и
 * РАЗБИРАЕТСЯ; сторожа стиля знают, что стиль ВАЛИДЕН. Ни один из них не
 * знает, что карта РИСУЕТСЯ: 112 клеток пересобраны с честным кодированием
 * дыр, и увидеть, как это выглядит, до сих пор мог только владелец в поле,
 * по одной клетке за выезд. Здесь тот же MapLibre, тот же стиль
 * (buildVedarStyle — не копия), те же файлы из бакета — в безголовом
 * Chromium на раннере, а кадры уходят артефактом прогона.
 *
 * Где исполняется (§8): раннер GitHub — он достаёт до бакета своими
 * ключами; из контейнера Claude бакет закрыт прокси, и локально этот скрипт
 * честно отвечает «не прогрузилось», а не рисует чёрное как «готово».
 *
 * ── Бакет — через свой локальный прокси, не напрямую из страницы ──────────
 *
 * Прогон 1 (05.09): все 14 кадров — «Failed to fetch (0)» на КАЖДЫЙ файл,
 * при том что verify-packs с того же раннера читает бакет целиком. Ноль
 * вместо HTTP-кода — это отказ браузера, не сервера: CORS. Бакет отдаёт
 * файлы только сайту (origin vedarai.ru), а страница снимка живёт на
 * 127.0.0.1 — и браузер её запросы к чужому origin не пускает, Range для
 * PMTiles тем более (preflight). Поэтому стиль просит файлы у ЛОКАЛЬНОГО
 * сервера (`/bucket/<ключ>`), а тот ходит в бакет из Node, где CORS нет,
 * и отдаёт как есть — вместе с кодом, Content-Range и Content-Length. Байты
 * те же, что читает карта в поле; меняется только то, кто их просит.
 *
 * Три исхода у каждого кадра (§4.0), и они не смешиваются:
 *   ok        — карта дошла до idle без единого отказа источника;
 *   broken    — MapLibre сообщил об отказе источника/тайла (файл не отдан,
 *               не разобран, глифы не пришли): кадр снят, но он — улика,
 *               а не картинка;
 *   timeout   — idle не наступил за бюджет: не «плохо», а «не смог
 *               проверить», и зелёным это не назвать.
 * Четвёртый исход у прогона целиком — no_webgl: безголовый Chromium без
 * WebGL не рисует ничего, и снимать «пустой div» как карту нельзя. Он
 * проверяется ДО пакетов на стиле из одного фона.
 *
 * Коды выхода: 0 — все кадры ok; 1 — есть broken; 3 — есть timeout (но нет
 * broken); 2 — прогон не состоялся (WebGL/адрес хранилища/неизвестный пакет).
 *
 *   MAP_PACK_BASE_URL=https://s3.example.ru/bucket \
 *   npx tsx scripts/map-tiles/snapshot-packs.ts --packs cell-52n157e,krai-overview --theme dark
 */

import { createServer, type Server } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { buildVedarStyle, type VedarMapTheme } from '@/lib/map/vedar-style';
import {
  resolvePackSource, BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, packRegionBbox, isOverviewId, type PackRegionId } from '@/lib/geo/regions';
import { gridCellById } from '@/lib/geo/grid-cells';

export type ShotVerdict = 'ok' | 'broken' | 'timeout';

export interface Shot {
  pack: string;
  zoom: number;
  center: { lat: number; lng: number };
  verdict: ShotVerdict;
  /** Отказы источников/тайлов словами MapLibre — что именно не пришло. */
  errors: string[];
  waitedMs: number;
  file: string | null;
}

/** Зумы кадров — по ярусу пакета: обзор живёт на z4-7, пакеты на z8-13. */
export function zoomsFor(pack: string): number[] {
  return isOverviewId(pack) ? [5, 7] : [8, 10, 12];
}

/** Центр кадра: у клетки он записан в реестре, у района и обзора — середина bbox. */
export function centerFor(pack: string): { lat: number; lng: number } | null {
  const cell = gridCellById(pack);
  if (cell) return cell.center;
  const b = packRegionBbox(pack);
  if (!b) return null;
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}

/** Все пакеты, у которых есть что снимать — тот же реестр, что у карты. */
export function snapshotTargets(): PackRegionId[] {
  return [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS];
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/maplibre/maplibre-gl.css">
<style>html,body,#map{margin:0;width:100%;height:100%;background:#000}</style>
<div id="map"></div>
<script src="/pmtiles.js"></script>
<script type="module">
  import * as maplibregl from '/maplibre/maplibre-gl.mjs';
  const q = new URLSearchParams(location.search);
  const state = { errors: [], idle: false, failed: null, webgl: null };
  window.__snap = state;
  try {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    const map = new maplibregl.Map({
      container: 'map',
      style: q.get('style'),
      center: [Number(q.get('lng')), Number(q.get('lat'))],
      zoom: Number(q.get('z')),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      // Без этого кадр берётся из уже стёртого буфера: WebGL по умолчанию
      // не хранит нарисованное после present.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    state.webgl = true;
    map.on('error', (e) => {
      const err = e && e.error ? e.error : e;
      const src = e && e.sourceId ? ' [' + e.sourceId + ']' : '';
      state.errors.push(String(err && err.message ? err.message : err) + src);
    });
    map.on('idle', () => { state.idle = true; });
    window.__map = map;
  } catch (err) {
    state.webgl = false;
    state.failed = String(err && err.message ? err.message : err);
  }
</script>`;

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.map': 'application/json',
};

/** Счёт запросов к бакету через прокси — чтобы в итоге сказать, сколько и с чем ушло. */
export interface ProxyStats { requests: number; failed: number; bytes: number; failures: string[] }

/** Сколько отказов прокси называть поимённо: дальше это уже не улика, а шум. */
const FAILURES_LISTED = 12;

/** Заголовки ответа бакета, которые нужны читателю PMTiles и карте. */
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Локальный статик: страница, MapLibre и pmtiles из node_modules, стили из
 * памяти — и прокси к бакету (`/bucket/<ключ>`), см. шапку файла про CORS.
 */
async function serve(
  styles: Map<string, string>, bucketBase: string, stats: ProxyStats,
): Promise<{ server: Server; origin: string }> {
  const mapDist = resolve('node_modules/maplibre-gl/dist');
  const pmtilesJs = resolve('node_modules/pmtiles/dist/pmtiles.js');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/bucket/')) {
        const key = url.pathname.slice('/bucket/'.length);
        stats.requests += 1;
        const headers: Record<string, string> = {};
        const range = req.headers.range;
        if (typeof range === 'string') headers.range = range;
        let upstream: Response;
        try {
          upstream = await fetch(`${bucketBase}/${key}`, { headers, cache: 'no-store' });
        } catch (err) {
          stats.failed += 1;
          if (stats.failures.length < FAILURES_LISTED) stats.failures.push(`сеть: ${key}${range ? ' [' + range + ']' : ''}`);
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`прокси: бакет не ответил — ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        if (upstream.status >= 400) {
          stats.failed += 1;
          if (stats.failures.length < FAILURES_LISTED) stats.failures.push(`HTTP ${upstream.status}: ${key}${range ? ' [' + range + ']' : ''}`);
        }
        stats.bytes += body.length;
        const out: Record<string, string> = {};
        for (const h of PASS_HEADERS) {
          const v = upstream.headers.get(h);
          if (v) out[h] = v;
        }
        res.writeHead(upstream.status, out);
        res.end(body);
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return;
      }
      if (url.pathname === '/pmtiles.js') {
        res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(await readFile(pmtilesJs)); return;
      }
      if (url.pathname.startsWith('/style/')) {
        const body = styles.get(url.pathname.slice('/style/'.length));
        if (!body) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME['.json'] }); res.end(body); return;
      }
      if (url.pathname.startsWith('/maplibre/')) {
        const name = url.pathname.slice('/maplibre/'.length);
        if (name.includes('..') || name.includes('/')) { res.writeHead(404); res.end(); return; }
        const file = join(mapDist, name);
        await stat(file);
        res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream' });
        res.end(await readFile(file)); return;
      }
      res.writeHead(404); res.end();
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

interface PageState { errors: string[]; idle: boolean; failed: string | null; webgl: boolean | null }

/** Ошибки самой страницы (модуль не загрузился, исключение вне try) — по ним видно, ПОЧЕМУ состояния нет. */
const pageErrors: string[] = [];

async function readState(page: Page): Promise<PageState> {
  const state = await page.evaluate(() => (window as unknown as { __snap?: PageState }).__snap ?? null);
  if (state) return state;
  // Состояния нет — скрипт страницы не дошёл до его создания. Это отказ
  // страницы, не карты, и молчать о нём нельзя: он выглядел бы как таймаут.
  return { errors: [], idle: false, webgl: pageErrors.length ? false : null,
    failed: pageErrors.length ? `скрипт страницы: ${pageErrors.slice(-2).join('; ')}` : null };
}

/** Ждёт idle карты. Возвращает состояние страницы и потраченное время. */
async function settle(page: Page, budgetMs: number): Promise<{ state: PageState; waitedMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const state = await readState(page);
    if (state.webgl === false || state.idle) return { state, waitedMs: Date.now() - t0 };
    await page.waitForTimeout(250);
  }
  return { state: await readState(page), waitedMs: Date.now() - t0 };
}

/** Проба WebGL: стиль из одного фона. Не нарисовался — снимать нечего. */
async function probeWebgl(page: Page, origin: string): Promise<string | null> {
  await page.goto(`${origin}/?style=/style/__probe.json&lat=53&lng=158&z=8`);
  const { state } = await settle(page, 20_000);
  if (state.webgl === false) return state.failed ?? 'MapLibre не создал карту (WebGL недоступен)';
  if (!state.idle) return 'карта из одного фона не дошла до idle за 20 с';
  return null;
}

function parseArgs(argv: string[]): { packs: string[] | null; theme: VedarMapTheme; out: string; budgetMs: number } {
  let packs: string[] | null = null;
  let theme: VedarMapTheme = 'dark';
  let out = '.cache/snapshots';
  let budgetMs = 90_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--packs') packs = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--theme') theme = argv[++i] === 'light' ? 'light' : 'dark';
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--budget-ms') budgetMs = Number(argv[++i]) || budgetMs;
  }
  return { packs, theme, out, budgetMs };
}

async function main(): Promise<number> {
  const { packs: wanted, theme, out, budgetMs } = parseArgs(process.argv.slice(2));
  const base = process.env.MAP_PACK_BASE_URL
    || (process.env.S3_BUCKET
      ? `${process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'}/${process.env.S3_BUCKET}`
      : '');
  if (!base) {
    console.error('Не задан адрес хранилища: нужен MAP_PACK_BASE_URL либо S3_BUCKET (+ S3_ENDPOINT).');
    return 2;
  }
  const all = snapshotTargets();
  const packs = wanted ?? all;
  const unknown = packs.filter((p) => !all.includes(p as PackRegionId));
  if (unknown.length) {
    console.error(`Пакетов нет в реестре собранных: ${unknown.join(', ')}. Снимать нечего.`);
    return 2;
  }

  // Стиль каждого пакета — тем же кодом, что у карты в поле. Своей копии
  // стиля здесь нет намеренно: снимок ДРУГОГО стиля ничего бы не доказывал.
  const styles = new Map<string, string>();
  styles.set('__probe.json', JSON.stringify({ version: 8, sources: {}, layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#224466' } },
  ] }));
  const stats: ProxyStats = { requests: 0, failed: 0, bytes: 0, failures: [] };
  const { server, origin } = await serve(styles, base.replace(/\/+$/, ''), stats);
  // Адреса файлов в стиле — через локальный прокси (см. шапку про CORS):
  // тот же resolvePackSource, что у карты, только база другая.
  const proxyBase = `${origin}/bucket`;
  const plan: Array<{ pack: string; zoom: number; center: { lat: number; lng: number } }> = [];
  for (const pack of packs) {
    const src = resolvePackSource(pack as PackRegionId, BUILT_PACK_REGIONS, proxyBase);
    if (src.state !== 'ready') {
      console.error(`${pack}: пакет не готов — ${src.reason}`);
      server.close();
      return 2;
    }
    const center = centerFor(pack);
    if (!center) { console.error(`${pack}: не знаю центра`); server.close(); return 2; }
    styles.set(`${pack}.json`, JSON.stringify(buildVedarStyle(theme, {
      terrainUrl: src.terrainUrl,
      contoursUrl: src.contoursUrl,
      terrainMaxZoom: src.terrainMaxZoom,
      attribution: '© Copernicus DEM (ESA)',
      glyphsUrl: src.glyphsUrl,
      glyphsFont: src.glyphsFont,
      osmUrls: src.osmUrls,
      vectorUrl: src.vectorUrl,
      placesUrl: src.placesUrl,
      oceanUrl: src.oceanUrl,
    })));
    for (const zoom of zoomsFor(pack)) plan.push({ pack, zoom, center });
  }

  await mkdir(out, { recursive: true });
  let browser: Browser | null = null;
  const shots: Shot[] = [];
  try {
    browser = await chromium.launch({
      headless: true,
      // Свой Chromium (контейнер с предустановленным браузером другой
      // версии); на раннере не задан — берётся тот, что поставил playwright install.
      ...(process.env.SNAPSHOT_CHROMIUM ? { executablePath: process.env.SNAPSHOT_CHROMIUM } : {}),
      // Программный WebGL: на раннере GPU нет, без этих флагов карта не
      // создаётся вовсе — и проба ниже это и покажет, а не промолчит.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
    const noWebgl = await probeWebgl(page, origin);
    if (noWebgl) {
      console.error(`WebGL недоступен — снимки не состоялись: ${noWebgl}`);
      await writeFile(join(out, 'summary.json'), JSON.stringify({ theme, base, outcome: 'no_webgl', reason: noWebgl, shots: [] }, null, 2));
      return 2;
    }
    console.log(`WebGL есть. Кадров: ${plan.length}, пакетов: ${packs.length}, тема: ${theme}, бюджет ${budgetMs / 1000} с на кадр`);

    for (const { pack, zoom, center } of plan) {
      const url = `${origin}/?style=/style/${pack}.json&lat=${center.lat}&lng=${center.lng}&z=${zoom}`;
      await page.goto(url);
      const { state, waitedMs } = await settle(page, budgetMs);
      const file = `${pack}.z${zoom}.${theme}.png`;
      await page.screenshot({ path: join(out, file) });
      const verdict: ShotVerdict = state.errors.length ? 'broken' : state.idle ? 'ok' : 'timeout';
      shots.push({ pack, zoom, center, verdict, errors: state.errors, waitedMs, file });
      const label = verdict === 'ok' ? 'снят' : verdict === 'broken' ? 'ОТКАЗ ИСТОЧНИКА' : 'НЕ ПРОГРУЗИЛСЯ';
      console.log(`${verdict === 'ok' ? ' ' : '!'} ${pack} z${zoom}: ${label} за ${(waitedMs / 1000).toFixed(1)} с${state.errors.length ? ' — ' + state.errors.slice(0, 3).join('; ') : ''}`);
    }
  } finally {
    await browser?.close();
    server.close();
  }

  const broken = shots.filter((s) => s.verdict === 'broken').length;
  const timeout = shots.filter((s) => s.verdict === 'timeout').length;
  const ok = shots.filter((s) => s.verdict === 'ok').length;
  const outcome = broken ? 'broken' : timeout ? 'timeout' : 'ok';
  await writeFile(join(out, 'summary.json'), JSON.stringify({ theme, base, outcome, ok, broken, timeout, proxy: stats, shots }, null, 2));
  const md = [
    `| пакет | зум | исход | ждали, с | отказы |`, `|---|---|---|---|---|`,
    ...shots.map((s) => `| ${s.pack} | ${s.zoom} | ${s.verdict} | ${(s.waitedMs / 1000).toFixed(1)} | ${s.errors.slice(0, 2).join('; ').replace(/\|/g, '/')} |`),
  ].join('\n');
  await writeFile(join(out, 'index.md'), md + '\n');
  console.log('');
  console.log(`запросов к бакету через прокси: ${stats.requests}, не 2xx/сетевых отказов: ${stats.failed}, принято ${(stats.bytes / 1024 / 1024).toFixed(1)} МБ`);
  // Отказы — поимённо (первые FAILURES_LISTED): «3 не 2xx» без адресов не
  // отличить «тайл за краем покрытия» от «файл пакета не отдан».
  for (const f of stats.failures) console.log(`  отказ прокси: ${f}`);
  console.log(`итого кадров: ${shots.length} — снято ${ok}, отказ источника ${broken}, не прогрузилось ${timeout}`);
  return broken ? 1 : timeout ? 3 : 0;
}

if (process.argv[1] && /snapshot-packs\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error('снимки: необработанный отказ', err);
    process.exit(2);
  });
}
