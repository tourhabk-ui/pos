/**
 * Какая часть карты нужна ЭТОМУ маршруту.
 *
 * До 09.08 офлайн-пакет качал прямоугольник вокруг точек маршрута с отступом
 * 15 км на зумах 10-12 с потолком в 2000 тайлов. Три беды разом:
 *
 *   1. Прямоугольник по точкам, а не коридор по треку. У маршрута с одной
 *      точкой («Мыс Маячный») прямоугольник рисовался вокруг неё, а трек
 *      уходил на двадцать километров и оказывался за краем. У длинного
 *      маршрута наоборот: огромный прямоугольник, где почти всё — море и
 *      тундра, куда человек не пойдёт.
 *   2. Потолок отрезал хвост списка, а список шёл от грубых зумов к детальным.
 *      Первым отрезался зум 12 — единственный, по которому можно идти. Молча.
 *   3. Зум 12 на широте Камчатки это одиннадцать метров в пикселе: экран
 *      телефона накрывает четыре километра. Для машины годится, для ног нет.
 *
 * Здесь то же самое решается коридором: полоса вдоль трека шириной в пару
 * километров. Для маршрута в двадцать километров это порядка двухсот пятидесяти
 * тайлов на зумах 12-15 — вчетверо меньше прежнего объёма при детализации в
 * три метра на пиксель.
 *
 * Правило потолка перевёрнуто: грубые зумы нужны всегда (по ним человек
 * понимает, где он вообще), детальные добавляются, пока есть бюджет. Отброшен
 * зум или нет — сказано вслух, а не спрятано в срезанном хвосте.
 *
 * Тот же вопрос — «какая часть карты нужна маршруту» — решается одинаково для
 * тайлов сегодня и для вырезки из своего файла карты завтра.
 */

import { lonToTile, latToTile, TILE_HOST } from '@/lib/offline/tiles';

/** Точка трека: [широта, долгота] — порядок, в котором трек приходит клиенту. */
export type TrackPoint = [number, number];

/** Ширина коридора в каждую сторону от трека. */
export const CORRIDOR_BUFFER_KM = 2;
/**
 * Зумы от грубого к детальному. 12 — «где я вообще», 15 — три метра в
 * пикселе, по нему видно тропу и распадок.
 */
export const CORRIDOR_ZOOMS = [12, 13, 14, 15];
/** Потолок по весу: больше человек не станет ждать перед выходом. */
export const CORRIDOR_MAX_MB = 60;

const KM_PER_DEG_LAT = 111.32;

/** Средний вес тайла OSM по зумам — на детальных больше деталей и байт. */
const AVG_KB_BY_ZOOM: Record<number, number> = { 12: 25, 13: 22, 14: 20, 15: 18 };

function avgKb(zoom: number): number {
  return AVG_KB_BY_ZOOM[zoom] ?? 20;
}

/**
 * Вес готового списка тайлов в мегабайтах.
 *
 * Нужен там, где коридора нет и план строится квадратом вокруг точки. Раньше
 * на этом пути вес не считался вовсе — сервер отдавал `estimate_mb: null`,
 * клиент превращал его в ноль, и кнопка предлагала «Сохранить карту · 0 МБ».
 *
 * Ноль тут не описка, а обратная ошибка: квадрат режется по 2000 тайлов, то
 * есть за этой кнопкой стоит порядка сорока мегабайт мобильного трафика.
 * Человек в поле читает «ноль» как «бесплатно» и жмёт.
 *
 * Зум берём из самого адреса — списки собираем мы же, формат `/{z}/{x}/{y}.png`
 * наш. Неразобранный адрес считаем по среднему, а не пропускаем: пропуск снова
 * занизил бы обещание.
 */
export function estimateTilesMb(tileUrls: string[]): number {
  if (tileUrls.length === 0) return 0;
  let kb = 0;
  for (const url of tileUrls) {
    const m = url.match(/\/(\d{1,2})\/\d+\/\d+\.png(?:\?|$)/);
    kb += avgKb(m ? Number(m[1]) : NaN);
  }
  return Math.max(1, Math.round(kb / 1024));
}

/**
 * Пересчёт трека на равный шаг по пути: точки ровно через stepKm.
 *
 * Работает в обе стороны, и обе нужны.
 *
 * Редкий трек — уплотняется. Иначе коридор рвётся: трек приходит прореженным,
 * на прямом участке между соседними точками бывает несколько километров,
 * буферы вокруг них не смыкаются, и в скачанной карте появляется дыра ровно
 * там, где дорога проще всего и человек идёт быстрее всего.
 *
 * Частый трек — прореживается. Треки бывают по три тысячи точек через восемь
 * метров; при буфере в два километра соседние такие точки дают один и тот же
 * квадрат, и вся разница — в потраченном времени.
 */
export function densify(track: TrackPoint[], stepKm: number): TrackPoint[] {
  if (track.length < 2) return [...track];
  const step = Math.max(stepKm, 0.01);
  const out: TrackPoint[] = [track[0]];
  let carry = 0; // сколько пути уже пройдено от последней выданной точки

  for (let i = 1; i < track.length; i++) {
    const [aLat, aLng] = track[i - 1];
    const [bLat, bLng] = track[i];
    const kmLng = KM_PER_DEG_LAT * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
    const segKm = Math.hypot((bLat - aLat) * KM_PER_DEG_LAT, (bLng - aLng) * kmLng);
    if (segKm === 0) continue;

    let pos = step - carry; // расстояние от начала отрезка до следующей точки
    while (pos <= segKm) {
      const t = pos / segKm;
      out.push([aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t]);
      pos += step;
    }
    carry = segKm - (pos - step);
  }

  // Конец маршрута обязателен: обрывать коридор за шаг до цели нельзя.
  const last = track[track.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

/** Ключи тайлов «z/x/y» для коридора на одном зуме. */
export function corridorTileKeys(
  track: TrackPoint[],
  zoom: number,
  bufferKm = CORRIDOR_BUFFER_KM,
): string[] {
  if (track.length === 0) return [];
  // Шаг уплотнения — половина буфера: соседние квадраты гарантированно
  // перекрываются, и коридор получается сплошным.
  const dense = densify(track, Math.max(bufferKm / 2, 0.25));
  const keys = new Set<string>();

  for (const [lat, lng] of dense) {
    const dLat = bufferKm / KM_PER_DEG_LAT;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dLng = bufferKm / (KM_PER_DEG_LAT * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));

    const xMin = lonToTile(lng - dLng, zoom);
    const xMax = lonToTile(lng + dLng, zoom);
    // В Web Mercator северу соответствует МЕНЬШИЙ Y.
    const yMin = latToTile(lat + dLat, zoom);
    const yMax = latToTile(lat - dLat, zoom);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) keys.add(`${zoom}/${x}/${y}`);
    }
  }
  return [...keys];
}

export interface CorridorPlan {
  urls: string[];
  /** Зумы, которые реально вошли. */
  zooms: number[];
  /** Зумы, отброшенные из-за потолка — детальные отбрасываются первыми. */
  droppedZooms: number[];
  tiles: number;
  estimateMb: number;
  bufferKm: number;
}

/**
 * План скачивания коридора: что качаем, сколько это весит и от чего пришлось
 * отказаться.
 *
 * Зумы добавляются от грубого к детальному, пока укладываемся в потолок.
 * Грубый слой нужен всегда: без него человек не поймёт, где он относительно
 * посёлка и дороги, — а без детального он всего лишь не увидит тропу.
 */
export function planCorridor(
  track: TrackPoint[],
  opts: { bufferKm?: number; zooms?: number[]; maxMb?: number } = {},
): CorridorPlan {
  const bufferKm = opts.bufferKm ?? CORRIDOR_BUFFER_KM;
  const zoomList = [...(opts.zooms ?? CORRIDOR_ZOOMS)].sort((a, b) => a - b);
  const maxMb = opts.maxMb ?? CORRIDOR_MAX_MB;

  const urls: string[] = [];
  const zooms: number[] = [];
  const droppedZooms: number[] = [];
  let kb = 0;

  for (const z of zoomList) {
    const keys = corridorTileKeys(track, z, bufferKm);
    const zoomKb = keys.length * avgKb(z);
    // Самый грубый зум берём всегда: карта без него бесполезна целиком, а с
    // ним — просто грубая. Отказ от детализации это неудобство, отказ от
    // ориентира это потеря карты.
    const isCoarsest = zooms.length === 0;
    if (!isCoarsest && (kb + zoomKb) / 1024 > maxMb) {
      droppedZooms.push(z);
      continue;
    }
    kb += zoomKb;
    zooms.push(z);
    for (const k of keys) urls.push(`https://${TILE_HOST}/${k}.png`);
  }

  return {
    urls,
    zooms,
    droppedZooms,
    tiles: urls.length,
    estimateMb: Math.max(1, Math.round(kb / 1024)),
    bufferKm,
  };
}
