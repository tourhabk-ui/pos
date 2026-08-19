/**
 * lib/routes/track-reconcile.ts — сверка нашей линии с сегодняшней страницей источника.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Владелец 18.08: если у источника треки живые, надо спарсить заново по новым
 * правилам и сравнить — может, мы спарсили неправильно.
 *
 * Это единственная проверка, которую нельзя заменить измерением базы. Всё, что
 * мы мерили до сих пор — плотность, высоты, непрерывность, границы, — считается
 * по тому, что В базе, и потому слепо к ПОТЕРЯМ: если разбор взял не тот блок,
 * обрезал трек или молча выкинул высоты, оставшееся выглядит безупречно.
 * Увидеть потерю можно только рядом с оригиналом.
 *
 * Основания подозревать потерю конкретные, а не общие:
 *
 *   1. Разборов было ДВА, и у каждого своя дыра (см. track-parse): прод-путь
 *      не проверял границ, путь скрипта терял высоту в порядке «широта
 *      первой» — том самом, которым отдаёт источник.
 *   2. Скрипт привинчивал трек к нашему маршруту по БЛИЗОСТИ: старт линии в
 *      пяти километрах от центра записи. Ни имени, ни идентификатора страницы
 *      при этом не сохранялось. Так линия и запись могут говорить о разном —
 *      и перепись 18.08 показала ровно это: «Восхождение на Вилючинский», чей
 *      трек не подходит к Вилючинскому ближе восьми километров.
 *
 * ── Что здесь есть и чего здесь нет ───────────────────────────────────────
 *
 * Здесь только СРАВНЕНИЕ — чистые функции над двумя наборами точек. Сеть,
 * запросы к базе и порядок обхода живут в вызывающем эндпоинте. Ничего не
 * пишется: сверка отвечает на вопрос «сходится ли», а решение по каждому
 * классу принимает человек.
 */

import { haversineKm } from '@/lib/on-route/eta';

/**
 * Насколько концы линий могут разойтись, оставаясь одной линией.
 *
 * Двести метров — это разметка и сглаживание на стороне источника, а не другой
 * путь. Больше — линии описывают разные вещи, и сравнивать их длины уже
 * бессмысленно.
 */
export const SAME_LINE_SHIFT_KM = 0.2;

/**
 * Насколько может отличаться число точек у одной и той же линии.
 *
 * Источник вправе перерисовать страницу и отдать чуть иную разметку. Десять
 * процентов — это разметка; больше — потеря или прибавка данных.
 */
export const POINTS_TOLERANCE = 0.1;

export type ReconcileVerdict =
  /** Линии совпадают, высоты на месте — разбор ничего не потерял. */
  | 'same'
  /** У нас точек заметно меньше: разбор взял не весь трек. */
  | 'ours_truncated'
  /** У нас точек заметно больше: у нас лежит что-то ещё, кроме трека. */
  | 'ours_extra'
  /** Линия та же, но высоты у нас нет, а у источника есть. */
  | 'elevation_lost'
  /** Концы разошлись: у нас и у источника РАЗНЫЕ линии. */
  | 'line_moved'
  /** Страница трека больше не отдаёт — сравнивать не с чем. */
  | 'source_has_no_track'
  /** У нас линии нет вовсе. */
  | 'ours_empty';

export interface ReconcileResult {
  verdict: ReconcileVerdict;
  ourPoints: number;
  theirPoints: number;
  /** Расхождение начал и концов линий, метры. `null` — сравнивать нечего. */
  startShiftM: number | null;
  endShiftM: number | null;
  ourElevation: boolean;
  theirElevation: boolean;
}

/** Точки приходят в порядке GeoJSON: [долгота, широта, высота?]. */
function hasElevation(coords: number[][]): boolean {
  return coords.some((p) => p.length >= 3 && Number.isFinite(p[2]));
}

function shiftM(a: number[] | undefined, b: number[] | undefined): number | null {
  if (!a || !b) return null;
  return Math.round(haversineKm(a[1], a[0], b[1], b[0]) * 1000);
}

export function reconcileTrack(ours: number[][], theirs: number[][]): ReconcileResult {
  const ourPoints = ours.length;
  const theirPoints = theirs.length;
  const ourElevation = hasElevation(ours);
  const theirElevation = hasElevation(theirs);

  const base = { ourPoints, theirPoints, ourElevation, theirElevation };

  // Порядок вердиктов — не вкусовщина. Сначала отвечаем, есть ли вообще что
  // сравнивать, потом — об ОДНОЙ ли линии речь, и только потом меряем
  // подробности. Иначе «у нас 40 точек, у них 400» прозвучит как потеря там,
  // где на деле сравнивали разные пути.
  if (theirPoints < 2) {
    return { verdict: 'source_has_no_track', startShiftM: null, endShiftM: null, ...base };
  }
  if (ourPoints < 2) {
    return { verdict: 'ours_empty', startShiftM: null, endShiftM: null, ...base };
  }

  const startShiftM = shiftM(ours[0], theirs[0]);
  const endShiftM = shiftM(ours[ourPoints - 1], theirs[theirPoints - 1]);
  // Судит НАЧАЛО, а не оба конца сразу.
  //
  // Первая редакция объявляла разными линиями всё, где разошёлся любой конец —
  // и тем закрывала себе главный вопрос: у обрезанного трека конец расходится
  // ПО ОПРЕДЕЛЕНИЮ. «Нас обрезали» и «это другой путь» — разные диагнозы, и
  // отличает их именно старт: обрезка сохраняет начало, чужая линия — нет.
  if (startShiftM !== null && startShiftM > SAME_LINE_SHIFT_KM * 1000) {
    return { verdict: 'line_moved', startShiftM, endShiftM, ...base };
  }
  if (ourPoints < theirPoints * (1 - POINTS_TOLERANCE)) {
    return { verdict: 'ours_truncated', startShiftM, endShiftM, ...base };
  }
  if (ourPoints > theirPoints * (1 + POINTS_TOLERANCE)) {
    return { verdict: 'ours_extra', startShiftM, endShiftM, ...base };
  }
  // Начало общее, точек поровну, а конец в стороне — линии всё-таки разные.
  if (endShiftM !== null && endShiftM > SAME_LINE_SHIFT_KM * 1000) {
    return { verdict: 'line_moved', startShiftM, endShiftM, ...base };
  }
  // Потеря высоты — последняя по порядку, но не по важности: высота это
  // улика записи прибором (lib/routes/track-evidence), то есть право линии
  // называться треком. Терялась она молча.
  if (theirElevation && !ourElevation) {
    return { verdict: 'elevation_lost', startShiftM, endShiftM, ...base };
  }
  return { verdict: 'same', startShiftM, endShiftM, ...base };
}

/**
 * Имена сверяются ОБЩИМ правилом — `isNamesakeOfRoute` (lib/routes/broken-links).
 *
 * Своё сравнение имён здесь прожило десять минут и было снято собственным
 * сторожем: «Долина гейзеров» и «Долина смерти» оно объявило одним местом,
 * потому что не знало о родовых словах. Правило, которое это знает, уже
 * написано и стережётся — второе такое же разошлось бы с ним ровно так же.
 */
export { isNamesakeOfRoute as titlesAgree } from '@/lib/routes/broken-links';


/**
 * ── Улика имеет срок годности ─────────────────────────────────────────────
 *
 * Сверка сравнивает нашу копию со страницей НА СЕГОДНЯ. Завтра источник её
 * перепишет, и «совпадает» превратится в историческую фразу, продолжая
 * выдавать право вести. Поэтому у сохранённой улики есть возраст, а у права —
 * условие свежести.
 *
 * Девяносто дней — предварительное значение, и оно названо предварительным
 * намеренно: настоящий интервал станет известен, когда перепись измерит, как
 * часто источник переписывает страницы (план, Ф6). Выдумывать «правильный»
 * срок до измерения — то же самое, что выдумывать курс обмена между
 * просмотром и бронью.
 */
export const CHECK_FRESH_DAYS = 90;

export type CheckFreshness = 'current' | 'review_due' | 'unknown';

/**
 * Насколько свежа сохранённая улика.
 *
 * `unknown` — проверки не было вовсе ЛИБО проверяли другую линию (наша
 * геометрия с тех пор изменилась). Второе намеренно не называется
 * «устаревшим»: устаревшая улика говорит о том же предмете, а эта — о другом,
 * и путать их нельзя.
 */
export function checkFreshness(
  check: { checkedAt: string | Date | null; geometryHash: string | null } | null,
  currentGeometryHash: string | null,
  now: Date,
): CheckFreshness {
  if (!check || !check.checkedAt) return 'unknown';
  if (check.geometryHash && currentGeometryHash && check.geometryHash !== currentGeometryHash) {
    return 'unknown';
  }
  const at = check.checkedAt instanceof Date ? check.checkedAt : new Date(check.checkedAt);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const ageDays = (now.getTime() - at.getTime()) / 86_400_000;
  return ageDays <= CHECK_FRESH_DAYS ? 'current' : 'review_due';
}

/**
 * Отпечаток линии — чтобы вердикт относился к ТОЙ САМОЙ геометрии.
 *
 * Не криптография: задача отличить одну нашу линию от другой, а не защититься
 * от подделки. Считается по числу точек и самим координатам, поэтому любая
 * правка геометрии меняет отпечаток.
 */
export function geometryFingerprint(coordinates: number[][]): string {
  let h = 2166136261;
  const put = (n: number) => {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
  };
  put(coordinates.length);
  for (const p of coordinates) {
    put(Math.round((p[0] ?? 0) * 1e5));
    put(Math.round((p[1] ?? 0) * 1e5));
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
