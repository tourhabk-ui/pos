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

import { projectOnTrack } from '@/lib/on-route/approach';

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
 * Сколько метров ПО ТРЕКУ пройдено до проекции точки на трек.
 *
 * Без этого профиль резался не там, где человек стоит: пройденное считалось по
 * прямым между путевыми точками, а координата профиля — по извилистому треку.
 * На горном маршруте трек длиннее прямых в полтора-два раза, значит «профиль
 * впереди» показывал бы кусок, который давно позади.
 *
 * Раньше метод был грубым — ближайшая ВЕРШИНА, без проекции на отрезок, с
 * оговоркой «трек всё равно прорежен, а GPS всё равно неточен». Оговорка не
 * выдержала проверки: на одном экране расстояние считалось проекцией на
 * ЗВЕНО (lib/on-route/approach), а рельеф — по вершинам, и два числа про одно
 * и то же положение расходились тем сильнее, чем реже стоят вершины. Вершины
 * прореженного трека стоят через сотни метров — это не «грубее на метры».
 *
 * Теперь правило одно и живёт в одном месте. Вторая реализация того же
 * понятия — это не запас прочности, а два ответа на один вопрос.
 */
export function distanceAlongTrack(
  track: Array<[number, number]>,
  lat: number,
  lng: number,
  /**
   * Шкала полного трека: `scaleDm[i]` — метры до i-й точки ПО ПОЛНОМУ треку.
   *
   * Трек приходит прореженным, и его собственная длина меньше настоящей — тем
   * сильнее, чем извилистее путь. Профиль высот индексирован полной длиной,
   * поэтому без шкалы срез профиля уезжает к началу на сотни метров. Со
   * шкалой ответ считается в той же мерке, в которой лежит профиль.
   *
   * Без неё функция по-прежнему считает по прореженной ломаной — это законно
   * для «сколько я прошёл», но не для среза профиля; вызывающий обязан знать
   * разницу.
   */
  scaleDm?: number[] | null,
): number | null {
  if (!Array.isArray(track) || track.length < 2) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const points = track.map(([tLat, tLng]) => ({ lat: tLat, lng: tLng }));
  const pr = projectOnTrack({ lat, lng }, points);
  if (!pr) return null;

  if (scaleDm && scaleDm.length === track.length) {
    // На самих точках это точно, между ними — линейно по доле вдоль звена.
    const a = scaleDm[pr.segment];
    const b = scaleDm[Math.min(pr.segment + 1, scaleDm.length - 1)];
    if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * pr.t;
  }

  let sum = 0;
  for (let i = 0; i < pr.segment; i++) sum += haversineM(points[i], points[i + 1]);
  sum += haversineM(points[pr.segment], pr.point);
  return sum;
}
