/**
 * lib/gear/availability.ts — одна формула занятости проката для всех дверей.
 *
 * Аудит 15.10, находка A13 (Д2-2): заявка `pending` держала единицу
 * снаряжения БЕССРОЧНО и ничего не стоила — оплаты через платформу нет, а
 * число заявок на человека не ограничивалось. Десятком заявок можно было
 * закрыть весь сток проката на сезон. Жильё то же место закрыло 26.09
 * (lib/stay/availability.ts); здесь — тем же устройством, своими числами.
 *
 * КТО ДЕРЖИТ ЕДИНИЦУ. Подтверждённая, выданная и просроченная аренда — всегда
 * (снаряжение у человека или обещано ему); заявка `pending` — только первые
 * GEAR_PENDING_HOLD_HOURS часов. Через срок заявка НЕ отменяется: прокат ещё
 * может её подтвердить, но подтверждение перепроверяет занятость под той же
 * блокировкой, что и новая заявка (PATCH /api/gear/rentals/[id]).
 *
 * Числа 48 ч и 3 — стартовые (решение A13 по карт-бланшу 15.10), их
 * пересматривают по первым заявкам сезона, а не по догадке.
 *
 * Модуль чистый — без базы и серверных импортов: сроки называет и форма.
 */

/** Сколько часов заявка без подтверждения держит единицу снаряжения. */
export const GEAR_PENDING_HOLD_HOURS = 48;

/**
 * Тот же срок литералом для SQL. Литерал, а не подстановка внутрь интервала:
 * сторож `sql-interval-not-concatenated` запрещает склейку, а совпадение с
 * числом выше держит tests/unit/gear-rental-door.test.ts.
 */
export const GEAR_PENDING_HOLD_INTERVAL_SQL = `INTERVAL '48 hours'`;

/**
 * Сколько одновременно открытых заявок (ещё держащих снаряжение) может быть
 * у одного человека на всём прокате. Три — несколько позиций на одну
 * поездку; больше — уже не заявка, а занятие чужого стока.
 */
export const MAX_OPEN_GEAR_REQUESTS_PER_USER = 3;

const ALIAS = /^[a-z_][a-z0-9_]*$/;

function alias(a: string): string {
  if (!ALIAS.test(a)) throw new Error(`gear availability: недопустимый алиас «${a}»`);
  return a;
}

/** Условие «аренда с алиасом r держит единицу снаряжения». */
export function holdsGearSql(r: string): string {
  const a = alias(r);
  return `(${a}.status IN ('confirmed', 'active', 'overdue')`
    + ` OR (${a}.status = 'pending' AND ${a}.created_at > NOW() - ${GEAR_PENDING_HOLD_INTERVAL_SQL}))`;
}

export interface GearPeakSqlOptions {
  /** SQL-выражение id позиции: плейсхолдер (`$1`). */
  gear: string;
  /** Первый день аренды — SQL-выражение типа date. */
  start: string;
  /** День ПОСЛЕ последнего (дата возврата) — SQL-выражение типа date. */
  endExclusive: string;
  /** Плейсхолдер id аренды, которую не считать (перепроверка при подтверждении). */
  excludeRental?: string;
}

/**
 * Пик одновременно занятых единиц позиции по дням окна: одна строка,
 * `peak_rented` (text). Считаются только аренды, которые держат единицу.
 */
export function gearPeakSql(o: GearPeakSqlOptions): string {
  const exclude = o.excludeRental ? `AND gr.id <> ${o.excludeRental}::uuid` : '';
  return `
      SELECT COALESCE(MAX(day_rented), 0)::text AS peak_rented
      FROM (
        SELECT SUM(gr.quantity) AS day_rented
        FROM generate_series(${o.start}, ${o.endExclusive} - 1, '1 day') AS d(day)
        LEFT JOIN gear_rentals gr
          ON gr.gear_id = ${o.gear}
         AND ${holdsGearSql('gr')}
         AND gr.start_date <= d.day
         AND gr.end_date > d.day
         ${exclude}
        GROUP BY d.day
      ) t`;
}

/**
 * Сколько открытых заявок у человека: `pending`, ещё держащие снаряжение.
 * Параметр $1 — id пользователя.
 */
export const OPEN_GEAR_REQUESTS_SQL = `
  SELECT COUNT(*)::int AS open_requests
    FROM gear_rentals r
   WHERE r.user_id = $1::uuid
     AND r.status = 'pending'
     AND r.created_at > NOW() - ${GEAR_PENDING_HOLD_INTERVAL_SQL}`;
