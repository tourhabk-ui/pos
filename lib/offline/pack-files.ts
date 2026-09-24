/**
 * Какие файлы своих пакетов карты нужны маршруту без связи (24.09).
 *
 * Скрин владельца с полевого экрана: «Карта не сохраняется». Кнопка
 * «Сохранить» слала service worker'у список растровых тайлов OSM, а закачка
 * их выключена с 28.08 (M0: политика OSM запрещает bulk download), — сохранить
 * не удавалось НИ РАЗУ, отказ был только назван. Шапка того отказа обещала:
 * «вернётся, когда появится собственный источник (PMTiles)». Источник давно
 * есть — поле рисуется нашими пакетами из хранилища, — а кнопку на них так и
 * не перевели.
 *
 * Здесь — чистый выбор файлов, без сети. Правило:
 *   - клетки сетки 1°×1°, которые задевает рамка маршрута: сетка покрывает
 *     сушу края, и клетка — самый детальный слой (z8-13);
 *   - если ни одной клетки нет — районные пакеты, которые рамку задевают;
 *   - обзор края (z4-7) всегда: без него при отдалении экран пустой;
 *   - глифы подписей — те диапазоны, в которых живут наши подписи.
 *
 * Каждый адрес — РОВНО тот, что просит карта (с эпохой кэша `e=`):
 * service worker ищет файл в кэше по точному адресу запроса. Префикс
 * `pmtiles://` снимается — его понимает протокол MapLibre, а читатель PMTiles
 * ходит в сеть по адресу без него.
 */
import type { RegionPack, ViewBounds } from '@/lib/map/field-base-map';
import { isGridCellId } from '@/lib/geo/grid-cells';
import { isOverviewId } from '@/lib/geo/regions';

/** Кэш, в который страница кладёт файлы и из которого их отдаёт service worker. */
export const PACK_CACHE_NAME = 'kh-packs-v1';

/**
 * Диапазоны глифов подписей. Кириллица (1024-1279) и латиница с «ёлочками» и
 * градусом (0-255) — сами имена; 256-511 — латиница с диакритикой в
 * названиях OSM; 8192-8447 — тире и кавычки-«лапки». Диапазон, которого в
 * хранилище нет, не валит сохранение — его отказ называется отдельно.
 */
export const GLYPH_RANGES = ['0-255', '256-511', '1024-1279', '8192-8447'] as const;

/** Поле вокруг рамки маршрута: точка у самого края клетки берёт и соседнюю. */
export const PACK_BOUNDS_PAD_DEG = 0.02;

export type PackFileKind = 'terrain' | 'vector' | 'contours' | 'places' | 'osm' | 'ocean' | 'manifest' | 'glyphs';

export interface PackFile {
  url: string;
  kind: PackFileKind;
  /** Пакет, которому файл принадлежит; у глифов — 'glyphs'. */
  pack: string;
}

export interface PackFilePlan {
  files: PackFile[];
  /** Какие пакеты взяты — чтобы назвать их человеку и в записи. */
  packs: string[];
  /** Взяты клетки сетки или (клеток не нашлось) районные пакеты. */
  basis: 'cells' | 'regions';
}

/** Адрес, по которому читатель PMTiles реально ходит в сеть. */
export function networkUrl(u: string): string {
  return u.startsWith('pmtiles://') ? u.slice('pmtiles://'.length) : u;
}

function padded(b: ViewBounds, pad: number): ViewBounds {
  return { south: b.south - pad, west: b.west - pad, north: b.north + pad, east: b.east + pad };
}

function intersects(p: RegionPack, v: ViewBounds): boolean {
  return p.bbox.west <= v.east && p.bbox.east >= v.west && p.bbox.south <= v.north && p.bbox.north >= v.south;
}

function filesOfPack(p: RegionPack): PackFile[] {
  const s = p.source;
  const out: PackFile[] = [];
  const add = (u: string | null | undefined, kind: PackFileKind) => {
    if (u) out.push({ url: networkUrl(u), kind, pack: p.region });
  };
  add(s.terrainUrl, 'terrain');
  // Векторный пакет заменяет слои OSM целиком (VedarMap берёт его, когда он
  // есть); качать и то и другое — платить дважды за одно.
  if (s.vectorUrl) add(s.vectorUrl, 'vector');
  else for (const u of Object.values(s.osmUrls)) add(u, 'osm');
  add(s.contoursUrl, 'contours');
  add(s.placesUrl, 'places');
  add(s.oceanUrl, 'ocean');
  add(s.manifestUrl, 'manifest');
  return out;
}

/**
 * Файлы для рамки маршрута. `null` — рамки нет (у маршрута ни линии, ни
 * точек): решать, какую карту качать, не из чего, и это не «качать нечего».
 */
export function planPackFiles(
  bounds: ViewBounds | null,
  packs: readonly RegionPack[],
): PackFilePlan | null {
  if (!bounds) return null;
  const v = padded(bounds, PACK_BOUNDS_PAD_DEG);
  const cells = packs.filter(p => isGridCellId(p.region) && intersects(p, v));
  const regions = packs.filter(p => !isGridCellId(p.region) && !isOverviewId(p.region) && intersects(p, v));
  const chosen = cells.length > 0 ? cells : regions;
  const overview = packs.find(p => isOverviewId(p.region));
  const all = [...(overview ? [overview] : []), ...chosen];

  const files: PackFile[] = [];
  const seen = new Set<string>();
  const push = (f: PackFile) => {
    if (seen.has(f.url)) return;
    seen.add(f.url);
    files.push(f);
  };
  for (const p of all) for (const f of filesOfPack(p)) push(f);

  const glyphs = all.map(p => p.source.glyphsUrl).find((u): u is string => typeof u === 'string');
  const font = all.map(p => p.source.glyphsFont).find((u): u is string => typeof u === 'string') ?? 'Noto Sans Regular';
  if (glyphs) {
    for (const range of GLYPH_RANGES) {
      // Тот же адрес, что соберёт MapLibre: шрифт в адресе кодируется
      // (пробел → %20), иначе ключ кэша не совпадёт с запросом карты.
      push({
        url: glyphs.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range),
        kind: 'glyphs',
        pack: 'glyphs',
      });
    }
  }
  return { files, packs: all.map(p => p.region), basis: cells.length > 0 ? 'cells' : 'regions' };
}
