/**
 * Отстаёт ли сохранённая карта маршрута от сегодняшней — проверкой, а не
 * сроком годности (#2808, 30.10).
 *
 * Предложение просило срок годности пакета: «старше N дней — обновите».
 * Число N неоткуда взять честно: рельеф и горизонтали не меняются годами,
 * а слой мест платформы переиздаётся после каждой партии правок координат
 * (map-places-build) — и его адрес несёт версию (`?v=`, PLACES_LAYER_VERSION,
 * lib/map/pack-source). Пакет, скачанный до смены версии, выглядит целым по
 * пробе Cache Storage (все СТАРЫЕ адреса на месте), а без связи карта
 * запросит НОВЫЙ адрес, которого в кэше нет, — и мест на карте не будет.
 * Дата закачки об этом не скажет ни при каком N.
 *
 * Поэтому свежесть здесь — расхождение между тем, что карта запросит
 * сегодня (план по текущему реестру пакетов), и тем, что лежит в кэше.
 * Исходы (§4.0): совпадает; отстаёт — названы недостающие слои; проверить
 * нечем — нет связи (план считает сервер), нет Cache Storage или план не
 * посчитан, и это не «свежая».
 *
 * Глифы подписей в сверке не участвуют: часть диапазонов в хранилище
 * отсутствует по построению (403), и без сети их «нет в кэше» неотличимо
 * от «не существует» (см. planRouteMap).
 */
import type { PackFile, PackFileKind } from '@/lib/offline/pack-files';
import { planRouteMapFiles } from '@/lib/offline/route-map-save';
import type { RegionPack } from '@/lib/map/field-base-map';

export type MapFreshness =
  | { state: 'current'; checked: number }
  | { state: 'behind'; missing: PackFile[]; checked: number; note: string }
  | { state: 'cannot_check'; reason: string };

const KIND_WORDS: Record<PackFileKind, string> = {
  terrain: 'рельеф',
  vector: 'векторный слой',
  contours: 'горизонтали',
  places: 'слой мест',
  osm: 'слои OSM',
  ocean: 'океан',
  manifest: 'паспорт пакета',
  glyphs: 'подписи',
};

/** Чего не хватает — словами, по одному разу на слой, в порядке плана. */
export function missingKindsWords(missing: readonly PackFile[]): string {
  const seen = new Set<PackFileKind>();
  const words: string[] = [];
  for (const f of missing) {
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    words.push(KIND_WORDS[f.kind]);
  }
  return words.join(', ');
}

/**
 * Какие файлы плана Cache Storage НЕ отдаёт. Ошибка похода в хранилище — не
 * отсутствие файла: такие адреса не считаются ни туда, ни сюда (`unchecked`).
 */
export async function missingFromCache(
  files: readonly PackFile[],
  cachesApi: CacheStorage | undefined = typeof caches !== 'undefined' ? caches : undefined,
): Promise<{ missing: PackFile[]; checked: number; unchecked: number } | null> {
  if (!cachesApi) return null;
  const hits = await Promise.all(files.map(async (f) => {
    try {
      // Request объектом, не строкой — см. probeCoverage (CodeQL).
      return (await cachesApi.match(new Request(f.url))) !== undefined;
    } catch {
      return null;
    }
  }));
  const missing: PackFile[] = [];
  let checked = 0;
  let unchecked = 0;
  hits.forEach((h, i) => {
    if (h === null) { unchecked++; return; }
    checked++;
    if (!h) missing.push(files[i]);
  });
  return { missing, checked, unchecked };
}

export function freshnessFromMissing(
  probe: { missing: PackFile[]; checked: number; unchecked: number } | null,
): MapFreshness {
  if (!probe) return { state: 'cannot_check', reason: 'нет Cache Storage' };
  if (probe.checked === 0) return { state: 'cannot_check', reason: 'хранилище не ответило ни по одному файлу' };
  if (probe.missing.length === 0) return { state: 'current', checked: probe.checked };
  const n = probe.missing.length;
  const files = n === 1 ? 'файла' : n < 5 ? 'файлов' : 'файлов';
  return {
    state: 'behind',
    missing: probe.missing,
    checked: probe.checked,
    note: `Карта в телефоне отстаёт от текущей: не хватает ${n} ${files} (${missingKindsWords(probe.missing)}) — докачайте, пока есть связь`,
  };
}

/**
 * Сверить сохранённую карту маршрута с сегодняшним планом.
 *
 * Зовётся со связью — план считает сервер (рамка маршрута), без связи
 * проверить нечем, и экран оставляет прежнюю строку готовности.
 */
export async function checkRouteMapFreshness(
  routeId: string,
  regionPacks: readonly RegionPack[],
  deps: { fetchFn?: typeof fetch; cachesApi?: CacheStorage; online?: boolean } = {},
): Promise<MapFreshness> {
  const online = deps.online ?? (typeof navigator === 'undefined' || navigator.onLine !== false);
  if (!online) return { state: 'cannot_check', reason: 'нет связи — сегодняшний план карты считает сервер' };
  const planned = await planRouteMapFiles(routeId, regionPacks, deps.fetchFn ?? fetch);
  if (!planned.ok) return { state: 'cannot_check', reason: planned.error };
  const files = planned.files.filter((f) => f.kind !== 'glyphs');
  const probe = await missingFromCache(files, deps.cachesApi ?? (typeof caches !== 'undefined' ? caches : undefined));
  return freshnessFromMissing(probe);
}
