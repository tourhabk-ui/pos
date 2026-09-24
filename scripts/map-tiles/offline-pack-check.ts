/**
 * Проверка делом: сохранённая карта открывается без связи (24.09).
 *
 * Скрин владельца с полевого экрана: «Карта не сохраняеться». Кнопку перевели
 * со старых растровых тайлов на свои пакеты (lib/offline/pack-files.ts,
 * pack-download.ts, ветка пакетов в public/sw.js). Юнит-тесты держат каждую
 * часть по отдельности; этот стенд проверяет связку целиком в настоящем
 * Chromium — тем же sw.js и тем же модулем закачки, что работают на телефоне:
 *
 *   1. страница регистрирует public/sw.js;
 *   2. модуль закачки кладёт файлы пакета в Cache Storage (как кнопка);
 *   3. «связь» обрывается: хранилище перестаёт отвечать вовсе;
 *   4. MapLibre рисует пакет — и всё, что он просит, обязан отдать
 *      service worker из сохранённого.
 *
 * Контроль — та же карта в чистом профиле без закачки: она обязана НЕ
 * нарисоваться. Без контроля «открылась без связи» могло бы значить
 * «связь не оборвалась».
 *
 * ── Хранилище — через свой прокси под настоящим именем ─────────────────────
 *
 * Бакет отдаёт файлы только сайту (CORS vedarai.ru), страница стенда живёт на
 * 127.0.0.1. Поэтому имя s3.twcstorage.ru разрешается в локальный прокси
 * (--host-resolver-rules), а тот ходит в бакет из Node и отдаёт байты как есть,
 * с Range. Имя важно: service worker узнаёт файлы пакета по хосту
 * twcstorage.ru и пути /map-packs/. Режим --local-bucket отдаёт файлы из
 * каталога — для отладки стенда без сети.
 *
 * Исходы (§4.0): 0 — сохранённая карта нарисовалась без связи, а контроль
 * нет; 1 — не нарисовалась или хранилище получило запрос после обрыва;
 * 3 — контроль нарисовался (проверка ничего не доказала); 2 — стенд не
 * состоялся.
 *
 *   MAP_PACK_BASE_URL=https://s3.twcstorage.ru/<bucket> \
 *   npx tsx scripts/map-tiles/offline-pack-check.ts --pack cell-53n158e --out .cache/offline-check
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { buildVedarStyle } from '@/lib/map/vedar-style';
import { builtRegionPacks } from '@/lib/map/field-base-map';
import { resolvePackSource, BUILT_PACK_REGIONS } from '@/lib/map/pack-source';
import { planPackFiles } from '@/lib/offline/pack-files';
import { packRegionBbox, type PackRegionId } from '@/lib/geo/regions';

const PACK_HOST = 's3.twcstorage.ru';

interface Args { pack: PackRegionId; out: string; localBucket: string | null; theme: 'dark' | 'light'; terrainOnly: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { pack: 'cell-53n158e' as PackRegionId, out: '.cache/offline-check', localBucket: null, theme: 'dark', terrainOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pack') a.pack = argv[++i] as PackRegionId;
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--local-bucket') a.localBucket = argv[++i];
    else if (argv[i] === '--theme') a.theme = argv[++i] === 'light' ? 'light' : 'dark';
    // Отладка стенда на синтетическом пакете: только рельеф, без векторов и глифов.
    else if (argv[i] === '--terrain-only') a.terrainOnly = true;
  }
  return a;
}

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8',
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/maplibre/maplibre-gl.css">
<style>html,body,#map{margin:0;width:100%;height:100%;background:#000}</style>
<div id="map"></div>
<script src="/pmtiles.js"></script>
<script src="/pd.js"></script>
<script type="module">
  import * as maplibregl from '/maplibre/maplibre-gl.mjs';
  window.__ml = maplibregl;
  maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
  window.__render = (style, center, zoom, budgetMs) => new Promise((done) => {
    const errors = [];
    let loaded = 0;
    const map = new maplibregl.Map({ container: 'map', style, center: [center.lng, center.lat], zoom, fadeDuration: 0, attributionControl: false });
    map.on('error', (e) => errors.push(String(e && e.error && e.error.message || e)));
    map.on('sourcedata', (e) => { if (e.tile && e.isSourceLoaded !== undefined) loaded++; });
    const t = setTimeout(() => done({ idle: false, errors, loaded }), budgetMs);
    map.once('idle', () => { clearTimeout(t); setTimeout(() => done({ idle: true, errors, loaded }), 300); });
  });
</script>`;

async function bundlePackDownload(): Promise<string> {
  const r = await build({
    entryPoints: [resolve('lib/offline/pack-download.ts')],
    bundle: true, format: 'iife', globalName: 'PD', write: false, platform: 'browser', target: 'es2020',
    alias: { '@': resolve('.') },
  });
  return r.outputFiles[0].text;
}

/** Прокси хранилища: байты из бакета (или каталога) с Range и CORS; «обрыв» — рвёт соединение. */
function startBucket(upstream: string | null, localDir: string | null) {
  const state = { offline: false, afterOffline: [] as string[], served: 0 };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'range',
      'access-control-expose-headers': 'Content-Length,Content-Range,Accept-Ranges,ETag',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (state.offline) {
      // Связи нет: не ответ с ошибкой, а обрыв — ровно как в поле.
      state.afterOffline.push(`${path}${req.headers.range ? ' [' + req.headers.range + ']' : ''}`);
      req.socket.destroy();
      return;
    }
    try {
      let body: Buffer;
      let status = 200;
      const headers: Record<string, string> = { ...cors, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      if (localDir) {
        const key = path.replace(/^\/[^/]+\//, '');
        const full = await readFile(join(localDir, key));
        headers.etag = `"${full.length}-${key.length}"`;
        headers['content-type'] = extname(key) === '.pmtiles' ? 'application/octet-stream' : 'application/geo+json';
        const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (m) {
          const s = Number(m[1]);
          const e = m[2] === '' ? full.length - 1 : Math.min(Number(m[2]), full.length - 1);
          body = full.subarray(s, e + 1); status = 206;
          headers['content-range'] = `bytes ${s}-${e}/${full.length}`;
        } else body = full;
      } else {
        const r = await fetch(`${upstream}${path.replace(/^\/[^/]+/, '')}${new URL(req.url ?? '/', 'http://x').search}`, {
          headers: req.headers.range ? { range: String(req.headers.range) } : {}, cache: 'no-store',
        });
        status = r.status;
        body = Buffer.from(await r.arrayBuffer());
        for (const h of ['content-type', 'content-range', 'etag']) {
          const v = r.headers.get(h);
          if (v) headers[h] = v;
        }
      }
      headers['content-length'] = String(body.length);
      state.served++;
      res.writeHead(status, headers);
      res.end(body);
    } catch {
      res.writeHead(404, cors); res.end();
    }
  });
  return { server, state };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // Тот же адрес хранилища, что у снимков (snapshot-packs.ts): явный либо из секретов бакета.
  const envBase = process.env.MAP_PACK_BASE_URL
    || (process.env.S3_BUCKET ? `${process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'}/${process.env.S3_BUCKET}` : '');
  const upstream = args.localBucket ? null : envBase.replace(/\/+$/, '');
  if (!args.localBucket && !upstream) { console.error('Нужен MAP_PACK_BASE_URL или --local-bucket'); return 2; }

  const bucket = startBucket(upstream, args.localBucket);
  await new Promise<void>((ok) => bucket.server.listen(0, '127.0.0.1', ok));
  const bport = (bucket.server.address() as { port: number }).port;
  // Настоящее имя хранилища: service worker узнаёт пакеты по нему.
  const base = `http://${PACK_HOST}:${bport}/bucket`;

  const bbox = packRegionBbox(args.pack);
  if (!bbox) { console.error(`пакет ${args.pack} не в реестре районов и клеток`); return 2; }
  const center = { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 };
  const view = { south: center.lat - 0.05, north: center.lat + 0.05, west: center.lng - 0.05, east: center.lng + 0.05 };
  const packs = builtRegionPacks(base).filter(p => p.region === args.pack);
  const plan = planPackFiles(view, packs);
  const src = resolvePackSource(args.pack, BUILT_PACK_REGIONS, base);
  if (!plan || src.state !== 'ready') { console.error(`пакет ${args.pack} не собран или план пуст`); return 2; }
  const style = buildVedarStyle(args.theme, {
    terrainUrl: src.terrainUrl, contoursUrl: src.contoursUrl, terrainMaxZoom: src.terrainMaxZoom,
    attribution: '© Copernicus DEM (ESA)', glyphsUrl: args.terrainOnly ? null : src.glyphsUrl, glyphsFont: src.glyphsFont,
    osmUrls: args.terrainOnly ? {} : src.osmUrls, vectorUrl: args.terrainOnly ? null : src.vectorUrl,
    placesUrl: args.terrainOnly ? null : src.placesUrl, oceanUrl: src.oceanUrl,
  });

  const pd = await bundlePackDownload();
  const sw = await readFile(resolve('public/sw.js'));
  const mapDist = resolve('node_modules/maplibre-gl/dist');
  const pmtilesJs = await readFile(resolve('node_modules/pmtiles/dist/pmtiles.js'));
  const app = createServer(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (p === '/') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return; }
      if (p === '/sw.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(sw); return; }
      if (p === '/pd.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(pd); return; }
      if (p === '/pmtiles.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(pmtilesJs); return; }
      if (p.startsWith('/maplibre/')) {
        const f = join(mapDist, p.slice('/maplibre/'.length));
        await stat(f);
        res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' }); res.end(await readFile(f)); return;
      }
      // Офлайн-заглушки service worker'а (precache) — пустые страницы.
      res.writeHead(200, { 'content-type': MIME['.html'] }); res.end('<!doctype html><title>stub</title>');
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;

  await mkdir(args.out, { recursive: true });
  let browser: Browser | null = null;
  const report: Record<string, unknown> = { pack: args.pack, files: plan.files.length, base: base.replace(/:\d+\//, ':<port>/') };
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SNAPSHOT_CHROMIUM ? { executablePath: process.env.SNAPSHOT_CHROMIUM } : {}),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        `--host-resolver-rules=MAP ${PACK_HOST} 127.0.0.1`],
    });

    // ── Основной прогон: сохранить, оборвать связь, открыть ──
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(origin);
    const controlled = await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
      return !!navigator.serviceWorker.controller;
    });
    if (!controlled) { await page.reload(); }
    const ctl2 = await page.evaluate(() => !!navigator.serviceWorker.controller);
    report.sw_controls_page = ctl2;
    if (!ctl2) { console.error('service worker не взял страницу под управление'); return 2; }

    const dl = await page.evaluate(async (files) => {
      const w = window as unknown as { PD: { downloadPackFiles: (f: unknown, p: () => void) => Promise<unknown> } };
      return w.PD.downloadPackFiles(files, () => {});
    }, plan.files) as { saved: number; bytes: number; failed: Array<{ kind: string; why: string }> };
    report.download = { saved: dl.saved, of: plan.files.length, mb: Math.round(dl.bytes / 1e5) / 10, failed: dl.failed };
    console.log(`закачка: ${dl.saved} из ${plan.files.length}, ${Math.round(dl.bytes / 1e5) / 10} МБ; не легли: ${dl.failed.map(f => `${f.kind} (${f.why})`).join(', ') || 'нет'}`);

    bucket.state.offline = process.env.OFFLINE_CHECK_NO_CUTOFF !== "1";
    const zoom = 10;
    const r1 = await page.evaluate(({ style, center, zoom }) => (window as unknown as { __render: (...a: unknown[]) => Promise<unknown> })
      .__render(style, center, zoom, 45_000), { style, center, zoom }) as { idle: boolean; errors: string[]; loaded: number };
    await page.screenshot({ path: join(args.out, `${args.pack}.offline.png`) });
    report.offline = { idle: r1.idle, loaded_tiles: r1.loaded, errors: r1.errors.slice(0, 8), bucket_hits_after_cutoff: bucket.state.afterOffline.slice(0, 12), page_errors: pageErrors.slice(0, 5) };
    console.log(`без связи: idle=${r1.idle}, тайлов=${r1.loaded}, ошибок=${r1.errors.length}, запросов в хранилище после обрыва=${bucket.state.afterOffline.length}`);
    for (const e of r1.errors.slice(0, 8)) console.log(`  ошибка: ${e}`);
    for (const h of bucket.state.afterOffline.slice(0, 12)) console.log(`  мимо кэша: ${h}`);
    await ctx.close();
    // Запросы мимо кэша — только основного прогона. Попытки контроля идут в
    // тот же счётчик позже, и прогон 1 (24.09) принял их за утечку.
    const hitsBefore = bucket.state.afterOffline.length;

    // ── Контроль: чистый профиль, без закачки, связи нет ──
    const ctx2 = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page2 = await ctx2.newPage();
    await page2.goto(origin);
    const r2 = await page2.evaluate(({ style, center, zoom }) => (window as unknown as { __render: (...a: unknown[]) => Promise<unknown> })
      .__render(style, center, zoom, 20_000), { style, center, zoom }) as { idle: boolean; errors: string[]; loaded: number };
    await page2.screenshot({ path: join(args.out, `${args.pack}.control.png`) });
    report.control = { idle: r2.idle, loaded_tiles: r2.loaded, errors: r2.errors.length, bucket_hits: bucket.state.afterOffline.length - hitsBefore };
    console.log(`контроль (без сохранения): idle=${r2.idle}, ошибок=${r2.errors.length}, попыток в хранилище=${bucket.state.afterOffline.length - hitsBefore}`);
    await ctx2.close();

    await writeFile(join(args.out, 'report.json'), JSON.stringify(report, null, 2));
    const offlineOk = r1.idle && r1.errors.length === 0 && hitsBefore === 0 && dl.saved > 0;
    const controlFailed = r2.errors.length > 0;
    if (!controlFailed) { console.log('ИТОГ: контроль нарисовался без связи — проверка ничего не доказала'); return 3; }
    if (!offlineOk) { console.log('ИТОГ: сохранённая карта без связи НЕ открылась целиком'); return 1; }
    console.log('ИТОГ: сохранённая карта открылась без связи; контроль без сохранения — нет');
    return 0;
  } catch (err) {
    console.error('стенд не состоялся:', err instanceof Error ? err.message : err);
    return 2;
  } finally {
    await browser?.close();
    bucket.server.close();
    app.close();
  }
}

main().then((c) => process.exit(c));
