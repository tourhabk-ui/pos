/**
 * lib/offline/tile-ownership.ts — какие тайлы можно удалить, не отняв карту
 * у того, кто её ещё держит.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * До 22.08.2026 «Удалить регион» не освобождало ничего. Кнопка снимала
 * метаданные и маршруты из IndexedDB — килобайты — и слала service worker'у
 * команду `CLEAR_REGION_TILES`. Обработчик команды не удалял НИЧЕГО: он
 * отвечал `REGION_CLEARED`, и человек видел подтверждение. Тайлы — от 6 до 22
 * МБ на регион — оставались навсегда: LRU-эвикция в service worker есть для
 * страниц мест, туров и поездок, а для тайлов её нет вовсе; кэш тайлов
 * чистится только сменой своей версии, то есть разом весь.
 *
 * Это не только про место. Когда квота исчерпана, браузер выбрасывает
 * хранилище источника ЦЕЛИКОМ — вместе с офлайн-маршрутами и полевыми
 * пакетами. То есть накопленный мусор бьёт по готовности к походу.
 *
 * ── Почему это вообще решаемо ────────────────────────────────────────────
 *
 * Комментарий в service worker утверждал: «удалить конкретный регион нельзя
 * без маппинга». Маппинг не нужен — адреса тайлов ВЫЧИСЛИМЫ:
 * `generateTileUrls(bbox)` для региона и `planCorridor(track, {bufferKm})`
 * для полевого пакета обе детерминированы, а всё нужное (bbox региона, трек и
 * буфер пакета) сохранено.
 *
 * ── Что здесь считается ──────────────────────────────────────────────────
 *
 * Осторожность в одну сторону. Регионы перекрываются (Паратунка и Авачинская
 * группа делят тайлы), коридор маршрута лежит внутри региона. Удалить тайл,
 * который держит кто-то ещё, — значит проделать дыру в чужой карте, и
 * обнаружится она в поле. Поэтому удаляется РОВНО разность: адреса уходящего
 * минус объединение адресов всех остающихся.
 *
 * Обратная ошибка дешевле: лишний оставшийся тайл занимает килобайты и будет
 * снят при следующем удалении соседа.
 */

import { REGIONS, type RegionId } from '@/lib/geo/regions';
import { generateTileUrls } from '@/lib/offline/tiles';
import { planCorridor, CORRIDOR_ZOOMS } from '@/lib/offline/route-corridor';

/** Адреса, которые держит один сохранённый объект (регион или полевой пакет). */
export interface TileHolder {
  /** Чем держится: `region:avachinsky`, `pack:<routeId>`. Для сообщений и отладки. */
  id: string;
  urls: string[];
}

export interface TileReleasePlan {
  /** Адреса, которые можно удалить: их не держит никто из остающихся. */
  release: string[];
  /** Сколько адресов уходящего пришлось оставить — их держит кто-то ещё. */
  kept: number;
}

/**
 * Что освободится, если убрать `leaving`, оставив `remaining`.
 *
 * `remaining` — ВСЕ прочие сохранённые объекты, а не только соседние регионы:
 * полевой пакет маршрута держит те же тайлы, что и регион вокруг него.
 */
export function planTileRelease(leaving: TileHolder, remaining: TileHolder[]): TileReleasePlan {
  const held = new Set<string>();
  for (const holder of remaining) {
    // Уходящий не удерживает сам себя: иначе удалять было бы нечего.
    if (holder.id === leaving.id) continue;
    for (const url of holder.urls) held.add(url);
  }

  const release: string[] = [];
  const seen = new Set<string>();
  let kept = 0;
  for (const url of leaving.urls) {
    if (seen.has(url)) continue; // один адрес — одно решение
    seen.add(url);
    if (held.has(url)) kept++;
    else release.push(url);
  }

  return { release, kept };
}

/**
 * Оценка освобождаемого объёма в мегабайтах.
 *
 * Средний вес тайла зависит от зума: чем детальнее, тем плотнее рисунок.
 * Цифры те же, что у оценки закачки (`estimateTilesMb`), — иначе обещание при
 * скачивании и обещание при удалении разошлись бы.
 *
 * Это ОЦЕНКА, и называть её точным числом нельзя: настоящий вес известен
 * только Cache Storage.
 */
const AVG_KB_BY_ZOOM: Record<number, number> = { 7: 6, 8: 8, 9: 10, 10: 15, 11: 20, 12: 25 };
const AVG_KB_FALLBACK = 15;

export function estimateReleaseMb(urls: string[]): number {
  let kb = 0;
  for (const url of urls) {
    // .../{z}/{x}/{y}.png — зум это первая из трёх последних частей адреса.
    const parts = url.split('/');
    const zoom = Number(parts[parts.length - 3]);
    kb += AVG_KB_BY_ZOOM[zoom] ?? AVG_KB_FALLBACK;
  }
  return Math.round((kb / 1024) * 10) / 10;
}

// ── Кто чем владеет на самом деле ─────────────────────────────────────────
//
// Ниже — переход от сохранённых записей к адресам. Обе формулы те же, что при
// скачивании: иначе удаление считало бы не то, что качалось.

/** Адреса тайлов региона. */
export function regionTileUrls(regionId: RegionId): string[] {
  const region = REGIONS[regionId];
  if (region === undefined) return [];
  return generateTileUrls(region.bbox);
}

/**
 * Адреса тайлов полевого пакета — восстанавливаются точно.
 *
 * `planCorridor` детерминирована от трека, а манифест хранит и трек, и буфер,
 * и отброшенные зумы. Пакет без трека или без сведений о тайлах адресов не
 * даёт: тогда честнее вернуть пустой список — он лишь запретит удалять
 * что-либо ради этого пакета, а не разрешит удалить лишнее.
 */
export function packTileHolder(rec: { routeId: string; manifest: unknown }): TileHolder {
  const empty: TileHolder = { id: `pack:${rec.routeId}`, urls: [] };
  const m = rec.manifest as {
    route?: { track?: Array<[number, number]> | null };
    tiles?: { bufferKm?: number | null; droppedZooms?: number[] } | null;
  } | null;
  const track = m?.route?.track;
  if (!Array.isArray(track) || track.length === 0 || m?.tiles == null) return empty;

  const dropped = new Set(m.tiles.droppedZooms ?? []);
  const zooms = CORRIDOR_ZOOMS.filter((z) => !dropped.has(z));
  // TrackPoint это [lat, lng] — та же форма, что хранит манифест.
  const plan = planCorridor(track, { bufferKm: m.tiles.bufferKm ?? undefined, zooms });
  return { id: `pack:${rec.routeId}`, urls: plan.urls };
}
