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
import {
  buildVedarStyle, buildRegionOverlay, DETAIL_MIN_ZOOM, type VedarMapTheme, type VedarStyleSources, type RegionTier,
} from '@/lib/map/vedar-style';
import { builtRegionPacks, regionsIntersecting } from '@/lib/map/field-base-map';
import {
  resolvePackSource, BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT, oceanKey,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, packRegionBbox, isOverviewId, type PackRegionId } from '@/lib/geo/regions';
import { gridCellById } from '@/lib/geo/grid-cells';
import { parseProbe } from '@/scripts/map-tiles/pack-census';

export type ShotVerdict = 'ok' | 'broken' | 'timeout';

export interface Shot {
  pack: string;
  zoom: number;
  center: { lat: number; lng: number };
  verdict: ShotVerdict;
  /** Отказы источников/тайлов словами MapLibre — что именно не пришло. */
  errors: string[];
  /** Тайлы, которых читатель PMTiles не нашёл в каталоге архива (ключ/z/x/y). */
  missing: string[];
  /** Состояние тайлов рельефа по источникам в момент кадра (см. tileDump). */
  tiles: string;
  waitedMs: number;
  file: string | null;
}

/** Зумы кадров — по ярусу пакета: обзор живёт на z4-7, пакеты на z8-13. */
export function zoomsFor(pack: string): number[] {
  // z4 — нижний зум обзора и всей карты (OVERVIEW_MIN_ZOOM): ниже карта не
  // уходит, кадр z3 был бы кадром того, чего человек не увидит. z6 добавлен
  // 06.09 (владелец: «z8 z7 z6 много ошибок») — до этого середина обзора
  // между z5 и z7 не снималась вовсе, а именно там сходятся океан, обзорный
  // рельеф и подписи посёлков/вершин.
  return isOverviewId(pack) ? [4, 5, 6, 7] : [8, 10, 12];
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

/** Границы кадра в градусах — по Web Mercator, как их видит карта. */
export function viewBounds(center: { lat: number; lng: number }, zoom: number, w: number, h: number) {
  const scale = 256 * 2 ** zoom;
  const x = (center.lng + 180) / 360 * scale;
  const r = (center.lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * scale;
  const lon = (px: number) => (px / scale) * 360 - 180;
  const lat = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / scale))) * 180) / Math.PI;
  return { west: lon(x - w / 2), east: lon(x + w / 2), north: lat(y - h / 2), south: lat(y + h / 2) };
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
  // missing — тайлы, на которые читатель PMTiles ответил «в каталоге нет»
  // (MapLibre из пустого буфера делает «could not be decoded», и по одному
  // тексту ошибки «нет тайла» от «битый тайл» не отличить — прогон 8, 05.09).
  // tiles — что пришло по каждому тайлу рельефа: байты и первые 8 байт (у
  // PNG это сигнатура). Отказ «could not be decoded» при полном архиве и
  // читаемом в Node тайле (перепись, прогон 9) — вопрос о том, ЧТО ИМЕННО
  // получил браузер; сюда это и записывается.
  const state = { errors: [], idle: false, failed: null, webgl: null, missing: [], tiles: {}, fetches: [] };
  window.__snap = state;
  const hex = (u8, n) => Array.from(u8.slice(0, n), (b) => b.toString(16).padStart(2, '0')).join('');
  window.__hex = hex;
  // fetches — каждый Range-запрос читателя PMTiles к архиву рельефа: что
  // просили и что пришло (код, Content-Length, Content-Range, длина тела).
  // Прогон 10: браузер получил по тайлу 3232 Б там, где в архиве 4778 Б, а
  // прямая проба тем же читателем — 4778. Значит расходятся не байты, а
  // ОТВЕТЫ на одинаковые запросы; здесь они записываются поимённо.
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await origFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('.terrain.pmtiles')) {
      const h = init && init.headers;
      const range = h instanceof Headers ? h.get('range') : h ? (h.range || h.Range || null) : null;
      const rec = { key: url.replace(/^.*\\/bucket\\/map-packs\\//, ''), range, status: r.status,
        len: r.headers.get('content-length'), cr: r.headers.get('content-range'), bodyLen: null };
      state.fetches.push(rec);
      try { rec.bodyLen = (await r.clone().arrayBuffer()).byteLength; } catch (err) { rec.bodyLen = 'отказ: ' + (err && err.message); }
    }
    return r;
  };
  try {
    const protocol = new pmtiles.Protocol();
    const shortKey = (url) => url.replace(/^pmtiles:\\/\\/[^ ]*?\\/bucket\\/map-packs\\//, '');
    maplibregl.addProtocol('pmtiles', async (params, ctrl) => {
      const r = await protocol.tile(params, ctrl);
      const key = shortKey(params.url);
      if (!r || r.data == null || (r.data.byteLength === 0)) state.missing.push(key);
      else if (key.includes('.terrain.pmtiles/')) state.tiles[key] = r.data.byteLength + ' Б ' + hex(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength), 8);
      return r;
    });
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
      const t = e && e.tile && e.tile.tileID && e.tile.tileID.canonical;
      const tile = t ? ' z' + t.z + '/' + t.x + '/' + t.y : '';
      state.errors.push(String(err && err.message ? err.message : err) + src + tile);
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
export interface ProxyStats {
  requests: number; failed: number; bytes: number; failures: string[];
  /** Повторы после сетевого отказа/5xx бакета (см. serve): сколько раз помогло. */
  retried: number;
  /** Журнал запросов к архивам рельефа: ключ, Range, код, длины — для сверки со страницей. */
  log: string[];
}

/** Повторов на запрос к бакету при сетевом отказе или 5xx: прогон 10 — два 502 на 1976 запросов. */
const PROXY_RETRIES = 2;

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
        let upstream: Response | null = null;
        let body: Buffer | null = null;
        let lastErr = '';
        // Сетевой отказ и 5xx бакета — повторить; ответ 2xx/4xx — как есть.
        for (let attempt = 0; attempt <= PROXY_RETRIES; attempt++) {
          if (attempt) { stats.retried += 1; await new Promise((ok) => setTimeout(ok, 300 * attempt)); }
          try {
            const r = await fetch(`${bucketBase}/${key}`, { headers, cache: 'no-store' });
            const b = Buffer.from(await r.arrayBuffer());
            if (r.status >= 500 && attempt < PROXY_RETRIES) { lastErr = `HTTP ${r.status}`; continue; }
            upstream = r; body = b; break;
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
          }
        }
        if (!upstream || !body) {
          stats.failed += 1;
          if (stats.failures.length < FAILURES_LISTED) stats.failures.push(`сеть: ${key}${range ? ' [' + range + ']' : ''} — ${lastErr}`);
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`прокси: бакет не ответил — ${lastErr}`);
          return;
        }
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
        if (key.includes('.terrain.pmtiles')) {
          stats.log.push(`${key} ${range ?? '-'} → ${upstream.status} len=${out['content-length'] ?? '-'} cr=${out['content-range'] ?? '-'} body=${body.length}`);
        }
        // Частичные ответы (206) браузеру НЕ кэшировать. Прогон 11 (05.09):
        // прокси отдал 4778 Б с Content-Length 4778, а страница прочла 3232 —
        // и это при двух соседних Range-запросах к тому же файлу в полёте.
        // Так Chromium склеивает частичные записи одного адреса в своём
        // HTTP-кэше; ровно от этого читатель PMTiles на Windows-Chrome ходит
        // с cache: 'no-store'. Тот же заголовок карта в поле получает от
        // хранилища (upload-pack.ts, CacheControl у архивов).
        out['cache-control'] = 'no-store';
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

interface PageState {
  errors: string[]; idle: boolean; failed: string | null; webgl: boolean | null; missing?: string[];
  /** `<пакет>.terrain.pmtiles/z/x/y` → «N Б <8 байт hex>» — что браузер получил по тайлу рельефа. */
  tiles?: Record<string, string>;
  /** Range-запросы страницы к архивам рельефа — см. PAGE. */
  fetches?: PageFetch[];
}

export interface PageFetch {
  key: string; range: string | null; status: number; len: string | null; cr: string | null; bodyLen: number | string | null;
}

/**
 * К отказу MapLibre по тайлу — что по этому тайлу пришло в браузер (байты,
 * сигнатура) и каким Range-запросом это пришло: запросы страницы к тому же
 * архиву, чья длина тела равна полученным байтам. `[terrain]` — основной
 * пакет кадра, `[terrain-<район>]` — подкладка.
 */
export function annotateErrors(errors: string[], tiles: Record<string, string>, pack: string, fetches: PageFetch[] = []): string[] {
  return errors.map((e) => {
    const m = /\[terrain(?:-([a-z0-9-]+))?\] z(\d+)\/(\d+)\/(\d+)/.exec(e);
    if (!m) return e;
    const archive = `${m[1] ?? pack}.terrain.pmtiles`;
    const key = `${archive}/${m[2]}/${m[3]}/${m[4]}`;
    const got = tiles[key];
    const bytes = got ? Number(got.split(' ')[0]) : NaN;
    const same = Number.isFinite(bytes)
      ? fetches.filter((f) => f.key === archive && f.bodyLen === bytes)
        .map((f) => `${f.range ?? 'без range'} → ${f.status}, len ${f.len ?? '—'}, ${f.cr ?? 'без content-range'}`)
      : [];
    return `${e} ← ${got ?? 'ответа по тайлу не записано'}${same.length ? ` [запросы: ${same.slice(0, 3).join('; ')}]` : ''}`;
  });
}

/**
 * Проба декодера без MapLibre: тот же читатель PMTiles через тот же прокси,
 * те же байты — и createImageBitmap напрямую. Отделяет «Chromium не читает
 * этот PNG» от «MapLibre что-то делает с тайлом по дороге».
 */
async function probeDecode(page: Page, origin: string, proxyBase: string, probes: Array<{ pack: string; zxy: [number, number, number] }>): Promise<string[]> {
  if (!probes.length) return [];
  await page.goto(`${origin}/?style=/style/__probe.json&lat=53&lng=158&z=8`);
  await settle(page, 20_000);
  const out: string[] = [];
  for (const { pack, zxy } of probes) {
    const url = `${proxyBase}/map-packs/${pack}.terrain.pmtiles`;
    const line = await page.evaluate(async ([u, z, x, y]: [string, number, number, number]) => {
      const w = window as unknown as { pmtiles: { PMTiles: new (u: string) => { getZxy(z: number, x: number, y: number): Promise<{ data: ArrayBuffer } | undefined> } }; __hex: (u8: Uint8Array, n: number) => string };
      try {
        const r = await new w.pmtiles.PMTiles(u).getZxy(z, x, y);
        if (!r) return 'в каталоге нет';
        const u8 = new Uint8Array(r.data);
        const head = w.__hex(u8, 8);
        try {
          const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }), { colorSpaceConversion: 'none' });
          return `${u8.byteLength} Б ${head} → декодирован ${bmp.width}x${bmp.height}`;
        } catch (err) {
          return `${u8.byteLength} Б ${head} → createImageBitmap: ${err instanceof Error ? err.message : String(err)}`;
        }
      } catch (err) {
        return `читатель: ${err instanceof Error ? err.message : String(err)}`;
      }
    }, [url, zxy[0], zxy[1], zxy[2]] as [string, number, number, number]);
    out.push(`${pack} ${zxy.join('/')}: ${line}`);
  }
  return out;
}

/**
 * Состояние тайлов рельефа в кадре — по источникам: сколько на каком зуме
 * loaded / errored / прочее. Прогон 8 (05.09): кадры z10 части клеток вышли
 * размытыми при idle без ошибок; «idle» значит лишь, что каждый тайл либо
 * загружен, либо ОТКАЗАН — а отказ с кодом 404 MapLibre глотает молча и
 * рисует родителя. Без этой сводки размытый кадр и целый кадр — одно слово «ok».
 */
async function tileDump(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const map = (window as unknown as { __map?: { style?: { tileManagers?: Record<string, unknown>; sourceCaches?: Record<string, unknown> } } }).__map;
      const managers = map?.style?.tileManagers ?? map?.style?.sourceCaches ?? {};
      const out: string[] = [];
      for (const id of Object.keys(managers)) {
        if (!id.startsWith('terrain')) continue;
        const tm = managers[id] as { _inViewTiles?: { getAllTiles(): unknown[] }; _tiles?: Record<string, unknown> };
        const tiles = (tm._inViewTiles ? tm._inViewTiles.getAllTiles() : Object.values(tm._tiles ?? {})) as Array<{ state: string; tileID: { canonical: { z: number; x: number; y: number } } }>;
        const counts: Record<string, number> = {};
        const bad: string[] = [];
        for (const t of tiles) {
          const k = `${t.state}@z${t.tileID.canonical.z}`;
          counts[k] = (counts[k] ?? 0) + 1;
          if (t.state !== 'loaded' && bad.length < 6) bad.push(`${t.state} z${t.tileID.canonical.z}/${t.tileID.canonical.x}/${t.tileID.canonical.y}`);
        }
        const parts = Object.entries(counts).sort().map(([k, n]) => `${k}=${n}`);
        out.push(`${id}: ${parts.join(' ')}${bad.length ? ' [' + bad.join(', ') + ']' : ''}`);
      }
      return out.join(' | ');
    });
  } catch (err) {
    return `сводка тайлов не снята: ${err instanceof Error ? err.message : String(err)}`;
  }
}

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

function parseArgs(argv: string[]): {
  packs: string[] | null; theme: VedarMapTheme; out: string; budgetMs: number; forceOcean: boolean;
  probes: Array<{ pack: string; zxy: [number, number, number] }>;
} {
  let packs: string[] | null = null;
  let theme: VedarMapTheme = 'dark';
  let out = '.cache/snapshots';
  let budgetMs = 90_000;
  // Океан обзора ДО включения флага: файл уже в бакете, а карта его ещё не
  // просит. Снимок с ним — единственный способ посмотреть на него глазами
  // прежде, чем обещать его полю (05.09: первый океан красил сушу).
  let forceOcean = false;
  // Пробы декодера (pack:z/x/y) — тайлы, на которые MapLibre жаловался в
  // прошлом прогоне; тот же разбор строки, что у переписи (pack-census).
  const probes: Array<{ pack: string; zxy: [number, number, number] }> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--packs') packs = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--theme') theme = argv[++i] === 'light' ? 'light' : 'dark';
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--budget-ms') budgetMs = Number(argv[++i]) || budgetMs;
    else if (a === '--force-ocean') forceOcean = true;
    else if (a === '--probe') for (const s of (argv[++i] ?? '').split(',')) if (s.trim()) probes.push(parseProbe(s));
  }
  return { packs, theme, out, budgetMs, forceOcean, probes };
}

async function main(): Promise<number> {
  const { packs: wanted, theme, out, budgetMs, forceOcean, probes } = parseArgs(process.argv.slice(2));
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
  const stats: ProxyStats = { requests: 0, failed: 0, bytes: 0, failures: [], retried: 0, log: [] };
  const { server, origin } = await serve(styles, base.replace(/\/+$/, ''), stats);
  // Адреса файлов в стиле — через локальный прокси (см. шапку про CORS):
  // тот же resolvePackSource, что у карты, только база другая.
  const proxyBase = `${origin}/bucket`;
  const allPacks = builtRegionPacks(proxyBase);
  const plan: Array<{ pack: string; zoom: number; center: { lat: number; lng: number }; name: string }> = [];
  for (const pack of packs) {
    const src = resolvePackSource(pack as PackRegionId, BUILT_PACK_REGIONS, proxyBase);
    if (src.state !== 'ready') {
      console.error(`${pack}: пакет не готов — ${src.reason}`);
      server.close();
      return 2;
    }
    const center = centerFor(pack);
    if (!center) { console.error(`${pack}: не знаю центра`); server.close(); return 2; }
    const sources: VedarStyleSources = {
      terrainUrl: src.terrainUrl,
      contoursUrl: src.contoursUrl,
      terrainMaxZoom: src.terrainMaxZoom,
      attribution: '© Copernicus DEM (ESA)',
      glyphsUrl: src.glyphsUrl,
      glyphsFont: src.glyphsFont,
      osmUrls: src.osmUrls,
      vectorUrl: src.vectorUrl,
      placesUrl: src.placesUrl,
      oceanUrl: src.oceanUrl ?? (forceOcean && isOverviewId(pack) ? `${proxyBase}/${oceanKey(OVERVIEW_ID)}` : null),
    };
    // Кадры: центр пакета на его зумах, а у клетки — ещё юго-западный угол
    // на z8 и z10: там сходятся четыре клетки, и стыки видны все сразу.
    const frames: Array<{ zoom: number; center: { lat: number; lng: number }; name: string }> = [];
    for (const zoom of zoomsFor(pack)) frames.push({ zoom, center, name: `${pack}.z${zoom}` });
    const cell = gridCellById(pack);
    if (cell) {
      const corner = { lat: cell.bbox.south + 0.03, lng: cell.bbox.west + 0.05 };
      for (const zoom of [8, 10]) frames.push({ zoom, center: corner, name: `${pack}.corner.z${zoom}` });
    }
    for (const f of frames) {
      // Соседи в кадре — как у VedarMap: их подкладки поверх основного стиля.
      // Без них снимок одной клетки не показал бы стыков, а полоса «не знаю»
      // на стыке (скрин владельца 05.09 06:44) живёт ровно там.
      const style = buildVedarStyle(theme, sources) as { sources: Record<string, unknown>; layers: Array<Record<string, unknown>> };
      const view = viewBounds(f.center, f.zoom, 900, 700);
      for (const region of regionsIntersecting(allPacks, view)) {
        if (region === pack) continue;
        const rp = allPacks.find((x) => x.region === region);
        if (!rp) continue;
        const tiers: RegionTier[] = isOverviewId(region) ? ['base'] : f.zoom >= DETAIL_MIN_ZOOM ? ['base', 'detail'] : ['base'];
        for (const tier of tiers) {
          const ov = buildRegionOverlay(theme, {
            terrainUrl: rp.source.terrainUrl, contoursUrl: rp.source.contoursUrl, terrainMaxZoom: rp.source.terrainMaxZoom,
            attribution: '© Copernicus DEM (ESA)', glyphsUrl: rp.source.glyphsUrl, glyphsFont: rp.source.glyphsFont,
            osmUrls: rp.source.osmUrls, vectorUrl: rp.source.vectorUrl, placesUrl: rp.source.placesUrl, oceanUrl: rp.source.oceanUrl,
          }, region, tier);
          for (const [id, srcDef] of Object.entries(ov.sources)) if (!(id in style.sources)) style.sources[id] = srcDef;
          for (const layer of ov.layers) {
            if (style.layers.some((l) => l.id === layer.id)) continue;
            // Заливки соседа — под его же тенью (как в VedarMap), остальное — сверху.
            const hillIdx = style.layers.findIndex((l) => l.id === `hillshade-${region}`);
            if (layer.type === 'fill' && hillIdx >= 0) style.layers.splice(hillIdx, 0, layer);
            else style.layers.push(layer);
          }
        }
      }
      styles.set(`${f.name}.json`, JSON.stringify(style));
      plan.push({ pack, zoom: f.zoom, center: f.center, name: f.name });
    }
  }

  await mkdir(out, { recursive: true });
  // Океан обзора — копией в кадры: из контейнера бакет не достать, а
  // геометрию для локальной пробы MapLibre нужно иметь на руках.
  if (forceOcean || packs.some((p) => isOverviewId(p))) {
    try {
      const res = await fetch(`${base}/${oceanKey(OVERVIEW_ID)}`, { cache: 'no-store' });
      if (res.status === 200) await writeFile(join(out, `${OVERVIEW_ID}.ocean.geojson`), Buffer.from(await res.arrayBuffer()));
      else console.log(`океан обзора не скопирован: HTTP ${res.status}`);
    } catch (err) {
      console.log(`океан обзора не скопирован: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
    const decoded = await probeDecode(page, origin, proxyBase, probes);
    if (decoded.length) {
      console.log('проба декодера (читатель PMTiles + createImageBitmap, без MapLibre):');
      for (const line of decoded) console.log(`  ${line}`);
      await writeFile(join(out, 'decode-probe.txt'), decoded.join('\n') + '\n');
    }

    for (const { pack, zoom, center, name } of plan) {
      const url = `${origin}/?style=/style/${name}.json&lat=${center.lat}&lng=${center.lng}&z=${zoom}`;
      await page.goto(url);
      const { state, waitedMs } = await settle(page, budgetMs);
      const file = `${name}.${theme}.png`;
      await page.screenshot({ path: join(out, file) });
      // JPEG рядом — для ветки map-snapshots: PNG в 400 КБ тянет историю
      // репозитория, JPEG в 60 — нет, а глазам хватает.
      await page.screenshot({ path: join(out, file.replace(/\.png$/, '.jpg')), type: 'jpeg', quality: 70 });
      const verdict: ShotVerdict = state.errors.length ? 'broken' : state.idle ? 'ok' : 'timeout';
      const tiles = await tileDump(page);
      const missing = state.missing ?? [];
      const errors = annotateErrors(state.errors, state.tiles ?? {}, pack, state.fetches ?? []);
      if (state.errors.length && state.fetches?.length) {
        // Все Range-запросы кадра к рельефу — в файл: по ним видно, что
        // просилось и что пришло, а не только по тайлу с отказом.
        await writeFile(join(out, `${name}.fetches.txt`),
          state.fetches.map((f) => `${f.key} ${f.range ?? '-'} → ${f.status} len=${f.len ?? '-'} cr=${f.cr ?? '-'} body=${String(f.bodyLen)}`).join('\n') + '\n');
      }
      shots.push({ pack, zoom, center, verdict, errors, missing, tiles, waitedMs, file });
      const label = verdict === 'ok' ? 'снят' : verdict === 'broken' ? 'ОТКАЗ ИСТОЧНИКА' : 'НЕ ПРОГРУЗИЛСЯ';
      console.log(`${verdict === 'ok' ? ' ' : '!'} ${name}: ${label} за ${(waitedMs / 1000).toFixed(1)} с${errors.length ? ' — ' + errors.slice(0, 3).join('; ') : ''}`);
      console.log(`    тайлы: ${tiles || 'источников рельефа нет'}`);
      if (missing.length) console.log(`    нет в каталоге (${missing.length}): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}`);
    }
  } finally {
    await browser?.close();
    server.close();
  }

  const broken = shots.filter((s) => s.verdict === 'broken').length;
  const timeout = shots.filter((s) => s.verdict === 'timeout').length;
  const ok = shots.filter((s) => s.verdict === 'ok').length;
  const outcome = broken ? 'broken' : timeout ? 'timeout' : 'ok';
  await writeFile(join(out, 'summary.json'), JSON.stringify({ theme, base, outcome, ok, broken, timeout, proxy: { ...stats, log: undefined }, shots }, null, 2));
  const md = [
    `| кадр | зум | исход | ждали, с | отказы | тайлы рельефа |`, `|---|---|---|---|---|---|`,
    ...shots.map((s) => `| ${s.file?.replace(/\.[a-z]+\.png$/, '') ?? s.pack} | ${s.zoom} | ${s.verdict} | ${(s.waitedMs / 1000).toFixed(1)} | ${s.errors.slice(0, 2).join('; ').replace(/\|/g, '/')}${s.missing.length ? ` нет в каталоге: ${s.missing.slice(0, 3).join(', ')}` : ''} | ${s.tiles.replace(/\|/g, '/')} |`),
  ].join('\n');
  await writeFile(join(out, 'index.md'), md + '\n');
  console.log('');
  console.log(`запросов к бакету через прокси: ${stats.requests}, не 2xx/сетевых отказов: ${stats.failed}, повторов ${stats.retried}, принято ${(stats.bytes / 1024 / 1024).toFixed(1)} МБ`);
  await writeFile(join(out, 'proxy.log'), stats.log.join('\n') + '\n');
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
