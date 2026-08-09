/**
 * Рельеф маршрута: набор, сброс и профиль высот.
 *
 * Владелец 09.08 прислал методику и главную мысль: без профиля в данных блок
 * «На маршруте» остаётся декоративным. Так и оказалось — график на экране
 * рисовал ШИРОТУ точек по вертикали, а не высоту: маршрут с севера на юг давал
 * ровную нисходящую линию, которая читается как спуск. Это хуже отсутствия
 * графика: пустое место заставляет достать карту, а красивая ложь — нет.
 *
 * Считаем один раз на сервере из трека и отдаём готовый профиль; клиент только
 * режет его от текущей позиции до следующей точки.
 *
 * Порог шума обязателен. Высота GPS и DEM «пилит» на несколько метров на
 * каждом отсчёте, и без порога сумма подъёмов на тридцати километрах вырастает
 * в разы: маршрут с честными 400 м набора покажет полторы тысячи, а по этому
 * числу турист решает, идти ли ему сегодня.
 */

export interface ReliefPoint {
  /** Расстояние от начала маршрута, м. */
  dM: number;
  /** Высота, м. */
  zM: number;
}

export interface RouteRelief {
  distanceM: number;
  ascentM: number;
  descentM: number;
  minM: number | null;
  maxM: number | null;
  points: ReliefPoint[];
  /**
   * Высоты настоящие, а не догадка. Ложь здесь опаснее пустоты: экран обязан
   * отличать «рельефа нет в данных» от «рельефа нет на местности».
   */
  reliable: boolean;
}

/** Ниже этого перепада между отсчётами — шум датчика, а не подъём. */
export const ELEVATION_NOISE_M = 3;
/** Реже этого профиль не прореживаем: полсотни метров хватает для графика. */
export const PROFILE_STEP_M = 50;
/** Меньше этой доли точек с высотой — данным верить нельзя. */
export const MIN_ELEVATION_COVERAGE = 0.6;

export interface TrackPointLike {
  lat: number;
  lng: number;
  elevation?: number;
}

export function haversineM(a: TrackPointLike, b: TrackPointLike): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function isEle(v: unknown): v is number {
  // Ноль — законная высота (уровень моря), поэтому проверяем не «истинность»,
  // а конечность числа. Абсурдные значения отбрасываем: высшая точка края —
  // Ключевская, около 4750 м.
  return typeof v === 'number' && Number.isFinite(v) && v > -500 && v < 9000;
}

export function accumulateRelief(points: TrackPointLike[]): RouteRelief {
  const empty: RouteRelief = {
    distanceM: 0, ascentM: 0, descentM: 0, minM: null, maxM: null, points: [], reliable: false,
  };
  if (!Array.isArray(points) || points.length < 2) return empty;

  const withEle = points.filter(p => isEle(p.elevation)).length;
  const reliable = withEle / points.length >= MIN_ELEVATION_COVERAGE;

  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  let minM: number | null = null;
  let maxM: number | null = null;
  const profile: ReliefPoint[] = [];
  // Опорная высота для порога шума — последняя ПРИНЯТАЯ, а не предыдущая:
  // иначе череда подъёмов по два метра не даст ни одного метра набора, хотя
  // склон реальный.
  let anchor: number | null = null;

  for (let i = 0; i < points.length; i++) {
    if (i > 0) distanceM += haversineM(points[i - 1], points[i]);
    const z = points[i].elevation;
    if (!isEle(z)) continue;

    minM = minM === null ? z : Math.min(minM, z);
    maxM = maxM === null ? z : Math.max(maxM, z);

    if (anchor === null) {
      anchor = z;
    } else {
      const dz = z - anchor;
      if (dz >= ELEVATION_NOISE_M) { ascentM += dz; anchor = z; }
      else if (dz <= -ELEVATION_NOISE_M) { descentM += -dz; anchor = z; }
    }

    const last = profile[profile.length - 1];
    if (!last || distanceM - last.dM >= PROFILE_STEP_M) {
      profile.push({ dM: Math.round(distanceM), zM: Math.round(z) });
    }
  }

  // Конец маршрута в профиле обязан быть: без него график обрывается раньше
  // финиша и «осталось подняться» врёт в меньшую сторону.
  const lastEle = [...points].reverse().find(p => isEle(p.elevation));
  if (lastEle && profile.length > 0 && profile[profile.length - 1].dM < Math.round(distanceM)) {
    profile.push({ dM: Math.round(distanceM), zM: Math.round(lastEle.elevation as number) });
  }

  return {
    distanceM: Math.round(distanceM),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    minM,
    maxM,
    points: reliable ? profile : [],
    reliable,
  };
}

export interface RemainingRelief {
  ascentM: number;
  descentM: number;
  points: ReliefPoint[];
}

/**
 * Рельеф от «я здесь» до следующей точки. Профиль режется, а не пересчитывается
 * заново: на маршруте важно не «сколько всего», а «что впереди».
 */
export function remainingRelief(
  profile: ReliefPoint[],
  fromM: number,
  toM: number,
): RemainingRelief {
  const empty: RemainingRelief = { ascentM: 0, descentM: 0, points: [] };
  if (!Array.isArray(profile) || profile.length < 2) return empty;
  if (!Number.isFinite(fromM) || !Number.isFinite(toM) || toM <= fromM) return empty;

  const slice = profile.filter(p => p.dM >= fromM && p.dM <= toM);
  if (slice.length < 2) return empty;

  let ascentM = 0;
  let descentM = 0;
  let anchor = slice[0].zM;
  for (let i = 1; i < slice.length; i++) {
    const dz = slice[i].zM - anchor;
    if (dz >= ELEVATION_NOISE_M) { ascentM += dz; anchor = slice[i].zM; }
    else if (dz <= -ELEVATION_NOISE_M) { descentM += -dz; anchor = slice[i].zM; }
  }

  return {
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    // Координата отсчитывается от текущего положения: у графика начало — «я».
    points: slice.map(p => ({ dM: p.dM - Math.round(fromM), zM: p.zM })),
  };
}

/* ─── Привязка положения к треку ──────────────────────────────────────────── */

/**
 * Сколько метров ПО ТРЕКУ пройдено до ближайшей к точке вершины.
 *
 * Без этого профиль резался не там, где человек стоит: пройденное считалось по
 * прямым между путевыми точками, а координата профиля — по извилистому треку.
 * На горном маршруте трек длиннее прямых в полтора-два раза, значит «профиль
 * впереди» показывал бы кусок, который давно позади. Ошибка ровно того рода,
 * что мы чиним на этом экране, поэтому исправлена до выката.
 *
 * Метод намеренно грубый — ближайшая ВЕРШИНА, без проекции на отрезок: трек
 * приходит прореженным, а точность GPS всё равно измеряется десятками метров.
 * Обещать большего, чем даёт вход, нельзя.
 */
export function distanceAlongTrack(
  track: Array<[number, number]>,
  lat: number,
  lng: number,
): number | null {
  if (!Array.isArray(track) || track.length < 2) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let bestIdx = 0;
  let bestD = Infinity;
  const cumulative: number[] = [0];

  for (let i = 0; i < track.length; i++) {
    const [tLat, tLng] = track[i];
    if (i > 0) {
      cumulative[i] = cumulative[i - 1] +
        haversineM({ lat: track[i - 1][0], lng: track[i - 1][1] }, { lat: tLat, lng: tLng });
    }
    const d = haversineM({ lat, lng }, { lat: tLat, lng: tLng });
    if (d < bestD) { bestD = d; bestIdx = i; }
  }

  return cumulative[bestIdx];
}
