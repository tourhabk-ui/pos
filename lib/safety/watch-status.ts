/**
 * lib/safety/watch-status.ts
 *
 * Что видит экстренный контакт на странице контроля выхода (/watch).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * До 03.10 контакт узнавал о туристе ровно одно: тревогу, когда срок уже
 * прошёл, текстом с последней точкой на момент отправки. Между тревогами
 * точка могла обновиться (трекер, телефон), а контакт об этом не знал. У
 * AllTrails (Live Share) и Strava (Beacon) близкий открывает ссылку и видит,
 * где человек был последний раз и когда (разбор конкурентов 03.10).
 *
 * ── Границы (docs/safety/WATCH_MANIFEST.md) ────────────────────────────────
 *
 * Правило 9: точка — только тому, кого она спасает. Поэтому вход тот же, что
 * у отметок (`openRegistrationForMark`): владелец аккаунта либо номер
 * телефона руководителя группы, который контакт знает. Ссылки из тревоги
 * мало — её можно переслать.
 *
 * Точка показывается, ПОКА КОНТРОЛЬ ОТКРЫТ. Вернулся или отменил — точки нет:
 * искать больше некого, а знать, где человек был, контакту уже незачем.
 *
 * Правило 6: незнание называется незнанием. Нет точки — «последняя точка
 * неизвестна», у точки всегда время и источник. Нет отметки — не «всё в
 * порядке», а «не отмечался».
 *
 * Страница только показывает. Отметки «вернулся» и «задерживаюсь» — свои
 * экраны (/return, /checkin-ok), правило 3: решения — по явному действию.
 */

export type WatchState =
  | 'returned'     // закрыт отметкой «вернулся»
  | 'cancelled'    // закрыт отменой
  | 'closed'       // закрыт, причина не записана (старые записи)
  | 'no_deadline'  // открыт, срок не задан
  | 'on_route'     // открыт, срок не прошёл
  | 'overdue';     // открыт, срок прошёл

export interface WatchRow {
  route_name: string;
  trip_kind: string | null;
  expected_return_at: string | Date | null;
  completed_at: string | Date | null;
  closed_reason: string | null;
  checkin_confirmed_at: string | Date | null;
  mchs_informed_at: string | Date | null;
  last_position_lat: string | number | null;
  last_position_lng: string | number | null;
  last_position_at: string | Date | null;
  last_position_source: string | null;
}

export interface WatchView {
  routeName: string;
  state: WatchState;
  expectedReturnAt: string | null;
  closedAt: string | null;
  checkinConfirmedAt: string | null;
  mchsInformedAt: string | null;
  /** null — точки нет либо контроль закрыт (см. шапку). */
  position: { lat: number; lng: number; at: string | null; source: string | null } | null;
}

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function watchView(row: WatchRow, now: Date): WatchView {
  const closedAt = iso(row.completed_at);
  const expectedReturnAt = iso(row.expected_return_at);

  let state: WatchState;
  if (closedAt) {
    state = row.closed_reason === 'returned' ? 'returned'
      : row.closed_reason === 'cancelled' ? 'cancelled'
      : 'closed';
  } else if (!expectedReturnAt) {
    state = 'no_deadline';
  } else {
    state = new Date(expectedReturnAt).getTime() < now.getTime() ? 'overdue' : 'on_route';
  }

  const lat = row.last_position_lat == null ? NaN : Number(row.last_position_lat);
  const lng = row.last_position_lng == null ? NaN : Number(row.last_position_lng);
  const position = !closedAt && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng, at: iso(row.last_position_at), source: row.last_position_source ?? null }
    : null;

  return {
    routeName: row.route_name,
    state,
    expectedReturnAt,
    closedAt,
    checkinConfirmedAt: iso(row.checkin_confirmed_at),
    mchsInformedAt: iso(row.mchs_informed_at),
    position,
  };
}

/** Подпись источника точки — те же слова, что в тревоге сторожа (formatPositionText). */
export function positionSourceLabel(source: string | null): string {
  if (source === 'tracker') return 'спутниковый трекер';
  if (source === 'phone') return 'телефон';
  // Не записан или неизвестное значение — не угадываем (§4.0).
  return 'источник не записан';
}
