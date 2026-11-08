/**
 * lib/mcp/booking-park-note.ts — закрыт ли парк тура на дату заявки
 * (разбор 08.11, внешний агент Qwen).
 *
 * create_booking_request принимал заявку на тур в Налычево на ноябрьскую дату
 * и молчал о том, что сводка «Вулканы Камчатки» закрыла маршруты всех
 * природных парков на межсезонье. План поездки (make_trip_plan, /planner) о
 * том же закрытии говорил — правилом lib/planner/park-status, — а заявка нет.
 *
 * Правило здесь то же самое, своего нет: тур привязан к парку маршрутом и
 * главным местом (`loadPlanParkAlerts`, предикат PARK_SCOPED_SQL — тот, что
 * красит места), дата решает (`parkNoteForDay`). Заявку закрытие не отменяет:
 * её подтверждает оператор. Строка говорит факт — сводку и её дату — и где
 * его проверить; обещать, что «оператор предупредит», нельзя: этого никто не
 * проверяет. Не смогли прочитать — так и сказано (§4.0), а не тишина,
 * которая читалась бы как «парк открыт».
 *
 * Строка зависит только от тура и даты, не от телефона: повтор заявки
 * получает тот же текст, что и новая (анти-оракул проверки MCP 29.09).
 */

import { pool } from '@/lib/db-pool';
import {
  loadPlanParkAlerts,
  parkNoteForDay,
  type ParkDayNote,
  type PlanParkAlert,
  type PlanParkQuery,
} from '@/lib/planner/park-status';

export const BOOKING_PARK_UNREAD_NOTE =
  'Проверить, нет ли на эту дату закрытия парка по маршруту тура, не удалось — перед выходом уточните у дирекции парка.';

/** Строка тревоги парка — только то, что отдаёт запрос планера (тип и сроки). */
function isParkAlertRow(row: unknown): row is PlanParkAlert {
  if (row === null || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return (r.alert_type === 'park_closure' || r.alert_type === 'park_status_unknown')
    && typeof r.title === 'string' && typeof r.published_iso === 'string' && typeof r.expires_iso === 'string';
}

/**
 * Что тревоги парка говорят о дате заявки — чистая, под тестом без базы.
 * Закрытие — первым, повторы одной строки — один раз.
 */
export function bookingParkLines(alerts: readonly unknown[], date: string, todayIso: string): string[] {
  const notes = alerts
    .filter(isParkAlertRow)
    .map((a) => parkNoteForDay(a, date, todayIso))
    .filter((n): n is ParkDayNote => n !== null)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  return [...new Set(notes.map((n) => n.text))];
}

const poolQuery: PlanParkQuery = async <T,>(sql: string, params: unknown[]) =>
  (await pool.query(sql, params)) as unknown as { rows: T[] };

/**
 * Хвост ответа о заявке: пусто — о парке тура на эту дату тревог нет;
 * иначе — строки планера с датой заявки; отказ чтения — словами.
 */
export async function bookingParkNote(
  tourId: number | string,
  date: string,
  todayIso: string,
  query: PlanParkQuery = poolQuery,
): Promise<string> {
  try {
    const alerts = await loadPlanParkAlerts(query, { routeIds: [], tourIds: [String(tourId)] });
    const lines = bookingParkLines(alerts, date, todayIso);
    if (lines.length === 0) return '';
    const [first, ...rest] = lines;
    return ` По парку этого тура на ${date}: ${first!.charAt(0).toLowerCase()}${first!.slice(1)}${rest.length ? ` ${rest.join(' ')}` : ''}`;
  } catch (err) {
    console.error('[mcp] закрытие парка для заявки на тур не проверено:', err instanceof Error ? err.message : err);
    return ` ${BOOKING_PARK_UNREAD_NOTE}`;
  }
}
