/**
 * Последняя известная точка — то, с чего навигатор открывается.
 *
 * Скрин владельца 02.09: экран «На маршруте» сначала показывал СТАРУЮ карту
 * (Leaflet, OSM-тайлы), и только через несколько секунд — свою. Причина не в
 * сборке и не в кэше: подложка выбирается по точке, а в первые секунды точки
 * нет — GPS ещё ищет спутники, маршрут ещё грузится. «Точки нет» читалось как
 * «своей карты нет», и экран честно рисовал Leaflet, чтобы через секунду его
 * выбросить.
 *
 * Все навигаторы открываются там, где их закрыли. Здесь то же: последний
 * фикс ложится на диск и служит точкой выбора подложки, пока живого фикса
 * нет. Это не «положение человека» (им остаётся только живой GPS — на
 * приборе сохранённая точка нигде не рисуется), это ответ на один вопрос:
 * «какой район открыть первым».
 */

import { isPlausibleTrackPoint } from '@/lib/routes/track';

export const LAST_FIX_KEY = 'field_last_fix_v1';

/** Старше этого сохранённая точка не используется: человек мог улететь. */
export const LAST_FIX_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface LastFix {
  lat: number;
  lng: number;
  /** Время фикса, мс. */
  t: number;
}

export function serializeLastFix(fix: LastFix): string {
  return JSON.stringify([fix.lat, fix.lng, fix.t]);
}

/**
 * Разбор сохранённой точки. Мусор, неправдоподобная координата (та же
 * проверка, что у следа и трека: сеть иногда отдаёт фикс за сотни км от
 * края) или слишком старая запись — это «точки нет», не падение.
 */
export function parseLastFix(raw: string | null, now = Date.now()): LastFix | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 3) return null;
    const [lat, lng, t] = parsed.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) return null;
    if (!isPlausibleTrackPoint(lat, lng)) return null;
    if (now - t > LAST_FIX_MAX_AGE_MS) return null;
    return { lat, lng, t };
  } catch {
    return null;
  }
}

export function readLastFix(storage: Pick<Storage, 'getItem'>, now = Date.now()): LastFix | null {
  try {
    return parseLastFix(storage.getItem(LAST_FIX_KEY), now);
  } catch {
    return null;
  }
}

/**
 * Запись без квоты на частоту: вызывающий пишет только когда фикс сменился,
 * а не на каждом тике, — и строка короткая (три числа).
 */
export function writeLastFix(storage: Pick<Storage, 'setItem'>, fix: LastFix): boolean {
  if (!isPlausibleTrackPoint(fix.lat, fix.lng)) return false;
  try {
    storage.setItem(LAST_FIX_KEY, serializeLastFix(fix));
    return true;
  } catch {
    return false;
  }
}
