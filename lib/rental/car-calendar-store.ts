/**
 * Чтение и отметка rental_car_busy. Партнёр — из привязанного чата:
 * чужую машину запрос не обновляет, пустой RETURNING — «не ваша», не ошибка.
 * Отказ базы — отдельный исход, с SQLSTATE в логе.
 */

import { pool } from '@/lib/db-pool';
import { containsPattern } from '@/lib/db/like';
import { isRealDate } from '@/lib/analytics/kamchatka-day';
import type { CalendarCar } from '@/lib/rental/car-calendar';

export type CalendarLoad =
  | { outcome: 'db_error' }
  | { outcome: 'ok'; cars: CalendarCar[] };

export async function loadCalendarCars(partnerId: string, car: string): Promise<CalendarLoad> {
  const q = car.trim().slice(0, 80);
  try {
    const { rows } = await pool.query<{ id: string; title: string; is_active: boolean }>(
      `SELECT id::text AS id, title, is_active
         FROM car_rental_offers
        WHERE partner_id = $1::uuid
          AND ($2::text = '' OR title ILIKE $3::text)
        ORDER BY is_active DESC, sort_order, title
        LIMIT 30`,
      [partnerId, q, containsPattern(q)],
    );
    return {
      outcome: 'ok',
      cars: rows.map((r) => ({ id: r.id, title: r.title, active: r.is_active === true })),
    };
  } catch (err) {
    console.error('[rental-calendar] прайс не прочитан, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return { outcome: 'db_error' };
  }
}

export async function loadCalendarMarks(
  offerId: string,
  from: string,
  to: string,
): Promise<Map<string, boolean> | 'db_error'> {
  try {
    const { rows } = await pool.query<{ day: string; busy: boolean }>(
      `SELECT day::text AS day, busy
         FROM rental_car_busy
        WHERE offer_id = $1::uuid
          AND day >= $2::date
          AND day <= $3::date`,
      [offerId, from, to],
    );
    const marks = new Map<string, boolean>();
    for (const row of rows) {
      if (!isRealDate(row.day) || typeof row.busy !== 'boolean') {
        console.error('[rental-calendar] отметка прочитана не датой или не да/нет — календарь не показываю');
        return 'db_error';
      }
      marks.set(row.day, row.busy);
    }
    return marks;
  } catch (err) {
    console.error('[rental-calendar] отметки не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return 'db_error';
  }
}

export type MarkWrite = 'saved' | 'not_yours' | 'db_error';

/**
 * Отметка прокатчика. Машина обязана быть его: partner_id в том же операторе,
 * что и вставка. Чужой id не создаёт строку.
 */
export async function setOperatorMark(
  partnerId: string,
  offerId: string,
  day: string,
  busy: boolean,
): Promise<MarkWrite> {
  try {
    const { rows } = await pool.query<{ offer_id: string }>(
      `INSERT INTO rental_car_busy (offer_id, day, busy, source)
       SELECT o.id, $3::date, $4::boolean, 'operator'
         FROM car_rental_offers o
        WHERE o.id = $1::uuid AND o.partner_id = $2::uuid
       ON CONFLICT (offer_id, day) DO UPDATE
         SET busy = EXCLUDED.busy,
             source = 'operator',
             lead_id = NULL,
             updated_at = NOW()
       RETURNING offer_id::text`,
      [offerId, partnerId, day, busy],
    );
    return rows.length === 1 ? 'saved' : 'not_yours';
  } catch (err) {
    console.error('[rental-calendar] отметка не записана, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return 'db_error';
  }
}
