/**
 * Дни, которые оператор (или платформа) закрыл в календаре тура, — для туров
 * БЕЗ календаря: «в любой день сезона» (#3476 шаг 3) и «по заявке».
 *
 * У такого тура строка `tour_availability` с `is_cancelled = TRUE` — не дата
 * расписания, а исключение: «в этот день не выезжаю». Бронь её уже не
 * пропускает (`DATE_BLOCKED`, lib/bookings/reserve), а запрос мест оператору и
 * список «свободно для заявки» у Кузьмича и MCP её не знали: турист звал
 * оператора на день, который тот сам закрыл, а его «Есть места» упиралось в
 * отказ брони.
 *
 * Поездка задевает закрытый день, если он внутри неё — многодневный тур
 * занимает все свои дни. Длину поездки вызывающий берёт правилом брони
 * (`tourDurationDays`, lib/bookings/duration): закрытый день судится той же
 * длиной, что DATE_BLOCKED в брони. Отказ базы — null («не
 * смог»), а не «закрытых дней нет» (§4.0).
 *
 * Сторож: tests/unit/tour-closed-days.test.ts; SQL — на PostgreSQL в
 * tests/integration/public-tour-gate.pg.test.ts.
 */
import { pool } from '@/lib/db-pool';

export const CLOSED_DAYS_SQL = `
  SELECT ta.date::text AS d
    FROM tour_availability ta
   WHERE ta.operator_tour_id = $1
     AND ta.is_cancelled = TRUE
     AND ta.deleted_at IS NULL
     AND ta.date BETWEEN $2::date AND $3::date
   ORDER BY ta.date`;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Закрытые дни тура с `from` по `to` включительно; отказ базы — null. */
export async function loadClosedDays(tourId: number | string, from: string, to: string): Promise<Set<string> | null> {
  try {
    const { rows } = await pool.query<{ d: string }>(CLOSED_DAYS_SQL, [tourId, from, to]);
    return new Set(rows.map((r) => r.d));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error('[closed-days] закрытые дни тура не прочитаны', { tourId: String(tourId), sqlstate: typeof code === 'string' ? code : null });
    return null;
  }
}

/** Последний день поездки, начатой `start`, длиной `days` календарных дней. */
export function tripEnd(start: string, days: number): string {
  return addDays(start, Math.max(1, days) - 1);
}

/** Задевает ли поездка с `start` на `days` дней хоть один закрытый день. */
export function tripHitsClosed(start: string, days: number, closed: ReadonlySet<string>): boolean {
  for (let i = 0; i < Math.max(1, days); i++) if (closed.has(addDays(start, i))) return true;
  return false;
}
