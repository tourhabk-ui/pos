/**
 * scripts/map-tiles/pack-census.ts — перепись архива рельефа в хранилище.
 *
 * Зачем (05.09, прогон снимков 8). После пересборки 122 пакетов «только
 * рельеф» кадры z10-12 у части клеток вышли РАЗМЫТЫМИ — прямоугольниками
 * по границам тайлов, то есть на месте подробного тайла карта растянула
 * родительский. Лог сборки при этом называл полный набор (у cell-54n158e:
 * 1352 тайла, z8-13), verify-packs видел целый заголовок, снимок дошёл до
 * idle без единого отказа. Три зелёных проверки — и ни одна не смотрела на
 * то, что лежит МЕЖДУ заголовком и кадром: каталог архива и байты тайла.
 *
 * Здесь читается ровно это, тем же читателем PMTiles, что у карты, с того
 * же адреса (раннер достаёт до бакета; контейнер Claude — нет, см. §8):
 *
 *   1. каталог — сколько тайлов на каждом зуме ЕСТЬ, против того, сколько
 *      ДОЛЖНО быть по bbox пакета (та же формула tile_range, что у
 *      build_terrain.py; заведена здесь второй раз намеренно — Python не
 *      читает TypeScript, и сторож в тестах сверяет обе на одних числах);
 *   2. проба — по одному тайлу на зум (середина охвата): пришёл ли, PNG ли
 *      это (сигнатура и IHDR), какие высоты в нём закодированы; плюс
 *      любые тайлы, названные в --probe, — те, на которые пожаловался
 *      MapLibre в кадре.
 *
 * Три исхода (§4.0): ok — каталог полон и пробы читаются; short — в
 * каталоге меньше тайлов, чем обещает bbox, или проба не PNG; unreachable —
 * бакет не ответил, и это «не смог проверить», а не «цел».
 *
 *   MAP_PACK_BASE_URL=https://s3.example.ru/bucket \
 *   npx tsx scripts/map-tiles/pack-census.ts --packs cell-54n158e,krai-overview \
 *     --probe cell-52n157e:9/480/167
 */

import { createRequire } from 'node:module';
import { PMTiles, tileIdToZxy, type Entry, type Header } from 'pmtiles';
import { packRegionBbox, isOverviewId, type RegionBbox, type PackRegionId } from '@/lib/geo/regions';
import { packKey, PACK_TERRAIN_MAXZOOM, OVERVIEW_MIN_ZOOM, OVERVIEW_MAX_ZOOM } from '@/lib/map/pack-source';
import { packUrl } from '@/scripts/map-tiles/verify-packs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as {
  PNG: { sync: { read(buf: Buffer): { width: number; height: number; data: Buffer } } };
};

/** Нижний зум пакета района/клетки — build_terrain.py MINZOOM. */
export const PACK_TERRAIN_MINZOOM = 8;

/** Сигнальная высота дыры DEM — build_terrain.py NODATA_SENTINEL_M. */
export const NODATA_SENTINEL_M = -500;

/**
 * Охват тайлов зума z по bbox — построчно та же формула, что
 * build_terrain.py tile_range(): int() в Python усекает к нулю, здесь —
 * Math.trunc. Возвращает [x0, x1, y0, y1], оба конца включительно.
 */
export function tileRange(bbox: RegionBbox, z: number): [number, number, number, number] {
  const n = 2 ** z;
  const xtile = (lng: number) => Math.trunc((lng + 180) / 360 * n);
  const ytile = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.trunc((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n);
  };
  return [xtile(bbox.west), xtile(bbox.east), ytile(bbox.north), ytile(bbox.south)];
}

/** Сколько тайлов на каждом зуме обязан нести пакет с таким bbox. */
export function expectedTileCounts(bbox: RegionBbox, minzoom: number, maxzoom: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let z = minzoom; z <= maxzoom; z++) {
    const [x0, x1, y0, y1] = tileRange(bbox, z);
    out[z] = (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return out;
}

/** Зумы пакета: обзор — свои, район и клетка — свои (lib/map/pack-source). */
export function packZoomRange(pack: string): { minzoom: number; maxzoom: number } {
  return isOverviewId(pack)
    ? { minzoom: OVERVIEW_MIN_ZOOM, maxzoom: OVERVIEW_MAX_ZOOM }
    : { minzoom: PACK_TERRAIN_MINZOOM, maxzoom: PACK_TERRAIN_MAXZOOM };
}

/** Высота из пикселя terrain-RGB (кодирование mapbox): -10000 + (R*65536 + G*256 + B) * 0.1. */
export function terrainRgbHeight(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

export interface TileProbe {
  zxy: string;
  /** null — тайла в каталоге нет (читатель вернул пусто). */
  bytes: number | null;
  png: boolean;
  size: string | null;
  /** Высоты по всем пикселям: мин, макс, доля сигнальной дыры. null — не PNG. */
  heights: { min: number; max: number; nodataShare: number } | null;
  error: string | null;
}

export interface PackCensus {
  pack: string;
  verdict: 'ok' | 'short' | 'unreachable';
  header: { minZoom: number; maxZoom: number; tiles: number; etag: string | null } | null;
  /** По зумам: сколько записей в каталоге (с учётом runLength) против ожидания по bbox. */
  zooms: Array<{ z: number; have: number; expected: number }>;
  probes: TileProbe[];
  detail: string;
}

/** Обход каталога PMTiles: корень и все листовые каталоги. Возвращает число тайлов по зумам. */
export async function countTilesByZoom(archive: PMTiles, header: Header): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  const walk = async (offset: number, length: number, depth: number): Promise<void> => {
    if (depth > 3) throw new Error('глубина каталога больше 3 — архив не по спецификации');
    const entries: Entry[] = await archive.cache.getDirectory(archive.source, offset, length, header);
    for (const e of entries) {
      if (e.runLength === 0) {
        await walk(header.leafDirectoryOffset + e.offset, e.length, depth + 1);
        continue;
      }
      // runLength > 1 — подряд идущие одинаковые тайлы (пустое море): они
      // ВСЕ есть в архиве, хоть и одной записью.
      for (let k = 0; k < e.runLength; k++) {
        const [z] = tileIdToZxy(e.tileId + k);
        counts[z] = (counts[z] ?? 0) + 1;
      }
    }
  };
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
  return counts;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function describePng(buf: Buffer): { png: boolean; size: string | null; heights: TileProbe['heights'] } {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { png: false, size: null, heights: null };
  const img = PNG.sync.read(buf);
  let min = Infinity;
  let max = -Infinity;
  let nodata = 0;
  const px = img.width * img.height;
  for (let i = 0; i < px; i++) {
    const h = terrainRgbHeight(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
    if (h <= NODATA_SENTINEL_M) { nodata += 1; continue; }
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return {
    png: true,
    size: `${img.width}x${img.height}`,
    heights: { min: min === Infinity ? NODATA_SENTINEL_M : Math.round(min), max: max === -Infinity ? NODATA_SENTINEL_M : Math.round(max), nodataShare: px ? nodata / px : 1 },
  };
}

async function probeTile(archive: PMTiles, z: number, x: number, y: number): Promise<TileProbe> {
  const zxy = `${z}/${x}/${y}`;
  try {
    const res = await archive.getZxy(z, x, y);
    if (!res) return { zxy, bytes: null, png: false, size: null, heights: null, error: 'в каталоге нет' };
    const buf = Buffer.from(res.data);
    const d = describePng(buf);
    return { zxy, bytes: buf.length, png: d.png, size: d.size, heights: d.heights, error: d.png ? null : `не PNG: ${buf.subarray(0, 8).toString('hex')}` };
  } catch (err) {
    return { zxy, bytes: null, png: false, size: null, heights: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function censusPack(
  pack: string, baseUrl: string, extraProbes: Array<[number, number, number]> = [],
): Promise<PackCensus> {
  const bbox = packRegionBbox(pack);
  if (!bbox) return { pack, verdict: 'unreachable', header: null, zooms: [], probes: [], detail: 'пакета нет в реестре' };
  const { minzoom, maxzoom } = packZoomRange(pack);
  // bbox нашёлся — значит id из реестра (район, клетка или обзор).
  const url = packUrl(baseUrl, packKey(pack as PackRegionId, 'terrain'));
  const archive = new PMTiles(url);
  let header: Header;
  try {
    header = await archive.getHeader();
  } catch (err) {
    return { pack, verdict: 'unreachable', header: null, zooms: [], probes: [], detail: `заголовок не прочитан: ${err instanceof Error ? err.message : String(err)}` };
  }
  let have: Record<number, number>;
  try {
    have = await countTilesByZoom(archive, header);
  } catch (err) {
    return {
      pack, verdict: 'unreachable',
      header: { minZoom: header.minZoom, maxZoom: header.maxZoom, tiles: header.numAddressedTiles, etag: header.etag ?? null },
      zooms: [], probes: [], detail: `каталог не прочитан: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const expected = expectedTileCounts(bbox, minzoom, maxzoom);
  const zooms = Object.keys(expected).map(Number).map((z) => ({ z, have: have[z] ?? 0, expected: expected[z] }));
  const probes: TileProbe[] = [];
  for (const z of Object.keys(expected).map(Number)) {
    const [x0, x1, y0, y1] = tileRange(bbox, z);
    probes.push(await probeTile(archive, z, Math.trunc((x0 + x1) / 2), Math.trunc((y0 + y1) / 2)));
  }
  for (const [z, x, y] of extraProbes) probes.push(await probeTile(archive, z, x, y));
  const shortZooms = zooms.filter((r) => r.have < r.expected);
  const badProbes = probes.filter((p) => !p.png);
  const headerOff = header.minZoom !== minzoom || header.maxZoom !== maxzoom;
  const problems: string[] = [];
  if (headerOff) problems.push(`заголовок обещает z${header.minZoom}-${header.maxZoom}, карта ждёт z${minzoom}-${maxzoom}`);
  if (shortZooms.length) problems.push(`в каталоге меньше, чем по bbox: ${shortZooms.map((r) => `z${r.z} ${r.have}/${r.expected}`).join(', ')}`);
  if (badProbes.length) problems.push(`пробы не читаются: ${badProbes.map((p) => `${p.zxy} (${p.error})`).join('; ')}`);
  return {
    pack,
    verdict: problems.length ? 'short' : 'ok',
    header: { minZoom: header.minZoom, maxZoom: header.maxZoom, tiles: header.numAddressedTiles, etag: header.etag ?? null },
    zooms, probes,
    detail: problems.length ? problems.join('; ') : 'каталог полон, пробы читаются',
  };
}

/** `pack:z/x/y` из --probe → [pack, [z,x,y]]; кривую запись называет, а не молчит. */
export function parseProbe(spec: string): { pack: string; zxy: [number, number, number] } {
  const m = /^([a-z0-9-]+):(\d+)\/(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`--probe ждёт pack:z/x/y, получено «${spec}»`);
  return { pack: m[1], zxy: [Number(m[2]), Number(m[3]), Number(m[4])] };
}

function parseArgs(argv: string[]): { packs: string[]; probes: Array<{ pack: string; zxy: [number, number, number] }> } {
  const packs: string[] = [];
  const probes: Array<{ pack: string; zxy: [number, number, number] }> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--packs') packs.push(...(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (argv[i] === '--probe') for (const s of (argv[++i] ?? '').split(',')) if (s.trim()) probes.push(parseProbe(s));
  }
  return { packs, probes };
}

export function formatCensus(c: PackCensus): string {
  const lines = [`${c.verdict === 'ok' ? ' ' : '!'} ${c.pack}: ${c.verdict} — ${c.detail}`];
  if (c.header) lines.push(`    заголовок: z${c.header.minZoom}-${c.header.maxZoom}, тайлов ${c.header.tiles}, etag ${c.header.etag ?? '—'}`);
  if (c.zooms.length) lines.push(`    каталог: ${c.zooms.map((r) => `z${r.z} ${r.have}/${r.expected}`).join(' · ')}`);
  for (const p of c.probes) {
    const h = p.heights ? `высоты ${p.heights.min}..${p.heights.max} м, дыра ${(p.heights.nodataShare * 100).toFixed(0)}%` : '';
    lines.push(`    проба ${p.zxy}: ${p.bytes === null ? 'нет' : `${p.bytes} Б`}${p.png ? ` PNG ${p.size}, ${h}` : ''}${p.error ? ` — ${p.error}` : ''}`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { packs, probes } = parseArgs(process.argv.slice(2));
  const base = process.env.MAP_PACK_BASE_URL
    || (process.env.S3_BUCKET ? `${process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'}/${process.env.S3_BUCKET}` : '');
  if (!base) {
    console.error('Не задан адрес хранилища: нужен MAP_PACK_BASE_URL либо S3_BUCKET (+ S3_ENDPOINT).');
    return 2;
  }
  const all = new Set([...packs, ...probes.map((p) => p.pack)]);
  if (!all.size) {
    console.error('Нужен --packs a,b или --probe pack:z/x/y.');
    return 2;
  }
  let short = 0;
  let unreachable = 0;
  for (const pack of all) {
    const c = await censusPack(pack, base, probes.filter((p) => p.pack === pack).map((p) => p.zxy));
    console.log(formatCensus(c));
    if (c.verdict === 'short') short += 1;
    if (c.verdict === 'unreachable') unreachable += 1;
  }
  console.log(`итого: пакетов ${all.size}, неполных ${short}, недоступных ${unreachable}`);
  return short ? 1 : unreachable ? 2 : 0;
}

if (process.argv[1] && /pack-census\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error('перепись: необработанный отказ', err);
    process.exit(2);
  });
}
