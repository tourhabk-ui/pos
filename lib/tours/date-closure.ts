/**
 * lib/tours/date-closure.ts — кто закрыл дату тура (план «после отказа», этап 6).
 *
 * Занятость тура (`fetchAvailabilityForTour`) отвечает одним «мест нет» на три
 * разных случая: места разобраны, дату закрыл оператор, дату закрыл Ведар по
 * оценке (миграция 1421: «зимой тур по его описанию под вопросом»). Первые два
 * — отказ. Третий отказом быть не может: оператора никто не спрашивал, и
 * «мест нет» о дате, которую никто не занимал, — неправда.
 *
 * Здесь — только третий случай, по признаку `tour_availability.closed_by`
 * (1435). По словам причины он не выводится: причину пишет и оператор.
 *
 * Три исхода (§4.0): закрыл Ведар, не Ведар (открыта, занята, закрыта
 * оператором или строки нет — здесь не различается), не прочиталось.
 * Сторожа: tests/unit/date-closure.test.ts,
 * tests/integration/tour-dates-open.pg.test.ts (признак и триггер 1435).
 */
import { pool } from '@/lib/db-pool';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** Дата тура закрыта Ведаром: живая строка календаря, закрытая, с признаком `platform`. */
export const DATE_CLOSED_BY_PLATFORM_SQL = `
  SELECT TRUE AS closed_by_platform
    FROM tour_availability ta
   WHERE ta.operator_tour_id = $1::bigint AND ta.date = $2::date
     AND ta.deleted_at IS NULL AND ta.is_cancelled IS TRUE AND ta.closed_by = 'platform'`;

/** Даты окна, закрытые Ведаром, — по возрастанию. */
export const DATES_CLOSED_BY_PLATFORM_SQL = `
  SELECT ta.date::text AS date
    FROM tour_availability ta
   WHERE ta.operator_tour_id = $1::bigint AND ta.date BETWEEN $2::date AND $3::date
     AND ta.deleted_at IS NULL AND ta.is_cancelled IS TRUE AND ta.closed_by = 'platform'
   ORDER BY ta.date`;

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'нет SQLSTATE';
}

/** true — закрыл Ведар; false — нет; null — не прочиталось (в лог). */
export async function isClosedByPlatform(
  tourId: number | string, date: string, deps: { query?: Query } = {},
): Promise<boolean | null> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const { rows } = await q(DATE_CLOSED_BY_PLATFORM_SQL, [String(tourId), date]);
    // Признак читается из строки, а не по её наличию: чужая строка в ответе «закрыл Ведар» не значит.
    return (rows as Array<{ closed_by_platform?: unknown }>).some((r) => r?.closed_by_platform === true);
  } catch (err) {
    console.error(`[date-closure] тур ${tourId}: кто закрыл дату ${date}, не прочитано, SQLSTATE`, codeOf(err));
    return null;
  }
}

/** Даты окна, закрытые Ведаром; null — не прочиталось (в лог). */
export async function datesClosedByPlatform(
  tourId: number | string, from: string, to: string, deps: { query?: Query } = {},
): Promise<string[] | null> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const { rows } = await q(DATES_CLOSED_BY_PLATFORM_SQL, [String(tourId), from, to]);
    return (rows as Array<{ date?: unknown }>).map((r) => String(r.date ?? '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch (err) {
    console.error(`[date-closure] тур ${tourId}: закрытые Ведаром даты окна не прочитаны, SQLSTATE`, codeOf(err));
    return null;
  }
}
