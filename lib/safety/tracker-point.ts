/**
 * lib/safety/tracker-point.ts
 *
 * Точка со спутникового трекера: разбор тела и приговор о пригодности.
 *
 * ── Почему здесь НЕТ адаптеров под вендоров ──────────────────────────────
 *
 * Соблазн был написать разбор под Garmin Outbound, под Spot, под каждого
 * следующего. Но вендорный адаптер без устройства в руках — провод в никуда
 * (§10.09): его нечем проверить, он зеленеет на выдуманном примере и
 * разойдётся с настоящим форматом в первый же день.
 *
 * Поэтому приёмник принимает ОДНУ нормализованную точку, а терпимость
 * ограничена именами полей. Это не «поддержка вендора», а признание того,
 * что `lat`, `latitude` и `Latitude` — одно и то же слово в разных регистрах:
 * такую терпимость можно проверить тестом, не имея ни одного трекера.
 *
 * Вложенные формы (`{Events:[{Point:{Latitude}}]}`) сознательно НЕ
 * разбираются. Между «не узнали форму» и «прочитали неправильно» разница
 * решающая: первое отвечает отказом с причиной, второе молча кладёт в
 * маршрут чужую координату. Форму, которую шлёт конкретное устройство,
 * приводит к нормальной шлюз вендора или одна строка в его настройках.
 *
 * ── Три исхода, не два ───────────────────────────────────────────────────
 *
 *   ok       — точка пригодна, её можно записать;
 *   rejected — точка есть, но ей нельзя верить (вне края, из будущего,
 *              протухшая). Причина называется словами и уходит в связку;
 *   unknown  — тела такой формы мы не знаем. Это НЕ «точки нет»: возможно,
 *              устройство шлёт верные координаты в неизвестном нам виде.
 *
 * Слить `rejected` и `unknown` нельзя: первое чинится у прибора, второе — у
 * нас или в настройках шлюза.
 */

/**
 * Конверт Камчатского края — тот же, что у `POST /api/safety/position`.
 *
 * Это грубый фильтр от нулей и перепутанных местами широты с долготой, а НЕ
 * проверка правды (§4.1, случай Тюшевских: 156.2/54.6 лежит внутри конверта
 * и при этом в Охотском море). Он ловит мусор, а не ошибку прибора.
 */
export const KRAI_LAT_MIN = 50;
export const KRAI_LAT_MAX = 58;
export const KRAI_LNG_MIN = 155;
export const KRAI_LNG_MAX = 165;

/**
 * Насколько старой может быть точка, чтобы считаться сообщением о «сейчас».
 *
 * Трекер копит точки, пока не видит спутник, и вываливает их пачкой — сутки
 * это запас на такой случай. Всё старше принимать нельзя: сторож невозврата
 * читает `last_position_at` как «где он был недавно», и вчерашняя точка,
 * записанная сегодня, увела бы поиск не туда.
 */
export const MAX_POINT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Запас на расхождение часов у прибора. Спутниковый приёмник берёт время из
 * системы GPS и обычно точен, но шлюз вендора может поставить своё.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type TrackerPointVerdict =
  | { kind: 'ok'; lat: number; lng: number; at: Date }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unknown'; reason: string };

/** Имена, которыми одно и то же поле называют разные шлюзы. */
const LAT_KEYS = ['lat', 'latitude', 'Latitude', 'Lat'];
const LNG_KEYS = ['lng', 'lon', 'long', 'longitude', 'Longitude', 'Lng', 'Lon'];
const AT_KEYS = ['at', 'time', 'timestamp', 'timeStamp', 'Time', 'Timestamp', 'dt'];

/** Число из строки или числа. `null` — не число (пустая строка тоже). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pick(body: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (k in body && body[k] != null) return body[k];
  }
  return undefined;
}

/**
 * Время точки. Отсутствие — законное состояние: многие шлюзы шлют только
 * координату, и тогда моментом считается приём. Непонятная строка — НЕ
 * молчаливый «сейчас»: это отказ, иначе протухшая точка станет свежей.
 */
function parseAt(raw: unknown, now: number): Date | 'absent' | 'bad' {
  if (raw == null || raw === '') return 'absent';
  if (typeof raw === 'number') {
    // Секунды или миллисекунды — различаем по порядку: 10^12 это 2001 год в
    // миллисекундах и 33-й век в секундах.
    const ms = raw > 1e12 ? raw : raw * 1000;
    return Number.isFinite(ms) ? new Date(ms) : 'bad';
  }
  if (typeof raw !== 'string') return 'bad';
  const n = Number(raw);
  if (Number.isFinite(n) && raw.trim() !== '') {
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return 'bad';
  // Время без зоны браузер и Node читают как локальное — на сервере это UTC,
  // и для точки из поля разницы нет. Проверку возраста делает вызывающий.
  void now;
  return d;
}

/**
 * Разобрать тело входящей точки.
 *
 * `now` параметром — чтобы проверять возраст и будущее без подмены часов.
 */
export function parseTrackerPoint(body: unknown, now: number = Date.now()): TrackerPointVerdict {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unknown', reason: 'тело не объект JSON' };
  }
  const b = body as Record<string, unknown>;

  const lat = num(pick(b, LAT_KEYS));
  const lng = num(pick(b, LNG_KEYS));

  if (lat === null || lng === null) {
    // Именно unknown: координаты, возможно, есть — но не там, где мы смотрим.
    return {
      kind: 'unknown',
      reason: `координат не нашлось; ожидаются поля ${LAT_KEYS[0]}/${LNG_KEYS[0]} `
        + '(или latitude/longitude) числом либо строкой',
    };
  }

  if (lat < KRAI_LAT_MIN || lat > KRAI_LAT_MAX || lng < KRAI_LNG_MIN || lng > KRAI_LNG_MAX) {
    return {
      kind: 'rejected',
      reason: `точка ${lat.toFixed(4)}/${lng.toFixed(4)} вне Камчатского края`,
    };
  }

  const parsed = parseAt(pick(b, AT_KEYS), now);
  if (parsed === 'bad') {
    return { kind: 'rejected', reason: 'время точки не разобралось' };
  }
  const at = parsed === 'absent' ? new Date(now) : parsed;

  const ageMs = now - at.getTime();
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return { kind: 'rejected', reason: 'время точки в будущем' };
  }
  if (ageMs > MAX_POINT_AGE_MS) {
    const hours = Math.round(ageMs / 3_600_000);
    return { kind: 'rejected', reason: `точке ${hours} ч — старше суток, свежей не считаем` };
  }

  return { kind: 'ok', lat, lng, at };
}
