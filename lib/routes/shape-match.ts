/**
 * lib/routes/shape-match.ts
 *
 * Лежат ли путевые точки на этом треке — и в этом ли порядке.
 *
 * ── Что мерили раньше и чего не хватало ────────────────────────────────────
 *
 * Расхождение линии маршрута и его точек мерилось одной величиной: «самая
 * дальняя точка от линии». Величина верная, но неполная — она не знает
 * ПОРЯДКА. Трек, проходящий те же места в обратную сторону или срезающий
 * половину пути, по ней неотличим от правильного: точки-то все на линии.
 *
 * ── Почему не расстояние Фреше ─────────────────────────────────────────────
 *
 * Первым делом я взял каноническую меру похожести кривых — дискретное
 * расстояние Фреше (Eiter & Mannila, 1994). На наших данных она не работает,
 * и это стоит записать, чтобы не браться за неё снова.
 *
 * Дискретный Фреше сцепляет ВЕРШИНЫ двух ломаных. У нас трек — сотни точек,
 * а путевых точек три-четыре. Вершина трека посередине между двумя путевыми
 * точками отстоит от обеих на половину их шага, и мера показывает этот шаг
 * разметки, а не расхождение путей. На тропе, размеченной через три
 * километра, идеальное совпадение даёт полтора километра «расхождения».
 *
 * Мера меряла бы плотность разметки. Подгонять под неё пороги — значит
 * подогнать инструмент под ответ.
 *
 * ── Что здесь ──────────────────────────────────────────────────────────────
 *
 * Точки проецируются НА ЛИНИЮ (на звенья, а не на вершины — `projectOnTrack`
 * это уже умеет), и получаются две величины разной природы:
 *
 *   отход  — насколько точка в стороне от линии. Прежняя мера, она верна;
 *   порядок — растёт ли положение вдоль трека от точки к точке.
 *
 * Порядок и есть то, чего не было. Он ловит и обратный обход, и перепутанную
 * последовательность, и не зависит от плотности разметки вовсе.
 */

import { projectOnTrack, straightKm, type GeoPoint } from '@/lib/on-route/approach';

export type WaypointFitVerdict =
  /** Точки лежат на линии и в правильном порядке. */
  | 'fits'
  /** Точки на линии, но порядок нарушен: тот же район, другой путь. */
  | 'out_of_order'
  /** Хотя бы одна точка далеко от линии. */
  | 'off_track'
  /** Сравнивать не из чего: нет линии или нет точек. */
  | 'unknown';

export interface WaypointFit {
  verdict: WaypointFitVerdict;
  /** Худший отход точки от линии, метры. NULL — не считали. */
  maxOffsetM: number | null;
  /**
   * Сколько раз положение вдоль трека пошло назад.
   *
   * NULL — точек меньше двух, порядка не существует. Ноль — порядок проверен
   * и не нарушен; разница между «ноль» и «нечего проверять» здесь та же, что
   * между «опасностей нет» и «мы про опасности не знаем».
   */
  inversions: number | null;
  /** Какую долю трека накрывают точки, 0..1. NULL — не считали. */
  coverage: number | null;
}

/**
 * Порог «точка в стороне от линии», метры.
 *
 * Путевая точка ставится не на тропу, а на МЕСТО: озеро отмечают у берега,
 * вулкан — на вершине или у подножия, источник — у купели. Полкилометра
 * такой разметки — обычная цена, а не признак другого пути.
 */
export const OFF_TRACK_M = 500;

/** Длина ломаной от начала до проекции, км. */
function alongKm(track: GeoPoint[], segment: number, t: number): number {
  let km = 0;
  for (let i = 0; i < segment; i++) km += straightKm(track[i], track[i + 1]);
  if (segment < track.length - 1) km += straightKm(track[segment], track[segment + 1]) * t;
  return km;
}

/**
 * Как путевые точки сидят на треке.
 *
 * Точки берутся В ПОРЯДКЕ МАРШРУТА — вызывающий обязан их так и передать.
 * Порядок, посчитанный по случайной перестановке, был бы не измерением, а
 * шумом, поэтому величина `inversions` осмысленна ровно настолько, насколько
 * осмыслен порядок на входе.
 */
export function waypointFit(track: GeoPoint[], waypoints: GeoPoint[]): WaypointFit {
  if (track.length < 2 || waypoints.length === 0) {
    return { verdict: 'unknown', maxOffsetM: null, inversions: null, coverage: null };
  }

  let total = 0;
  for (let i = 1; i < track.length; i++) total += straightKm(track[i - 1], track[i]);

  let maxOffsetM = 0;
  const positions: number[] = [];
  for (const w of waypoints) {
    const pr = projectOnTrack(w, track);
    if (!pr) continue;
    const offM = pr.offTrackKm * 1000;
    if (offM > maxOffsetM) maxOffsetM = offM;
    positions.push(alongKm(track, pr.segment, pr.t));
  }

  if (positions.length === 0) {
    return { verdict: 'unknown', maxOffsetM: null, inversions: null, coverage: null };
  }

  // Порядок существует только начиная с двух точек. У одной его нет — и это
  // не «порядок не нарушен», а «проверять нечего».
  const inversions = positions.length < 2
    ? null
    : positions.reduce((n, p, i) => (i > 0 && p < positions[i - 1] ? n + 1 : n), 0);

  const coverage = total > 0
    ? Math.min(1, (Math.max(...positions) - Math.min(...positions)) / total)
    : null;

  const verdict: WaypointFitVerdict =
    maxOffsetM > OFF_TRACK_M ? 'off_track'
      : inversions !== null && inversions > 0 ? 'out_of_order'
        : 'fits';

  return {
    verdict,
    maxOffsetM: Math.round(maxOffsetM),
    inversions,
    coverage: coverage === null ? null : Math.round(coverage * 100) / 100,
  };
}
