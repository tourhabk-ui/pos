/**
 * «Ближайшая свободная дата тура» — ОДНО условие на все витрины (правило 1в,
 * слово владельца 29.10).
 *
 * До 29.10 условие жило тремя копиями, и они расходились: каталог Кузьмича и
 * MCP считали «сегодня» по Камчатке, с горизонтом в год и потолком
 * `max_participants`; каталог сайта, главная и посадочные страницы — по
 * `CURRENT_DATE` пояса сессии БД, без горизонта и без потолка. Один и тот же
 * тур мог быть «с датой» в одном списке и «без даты» в соседнем — а по этой
 * дате теперь строится порядок всех общих витрин (lib/tours/offer-order).
 *
 * Эталон — бывший LATERAL каталога Кузьмича:
 *   - дата не раньше сегодняшней по Камчатке и не позже чем через год;
 *   - строка календаря не отменена и не удалена;
 *   - свободных мест на дату больше нуля: вместимость — меньшее из слотов
 *     даты и `max_participants`, занятость — общее правило броней
 *     (lib/bookings/occupancy: многодневная бронь держит все свои дни).
 *
 * Тур без календаря («даты по заявке») свободной даты не имеет — null; сезон в
 * порядке не участвует, он нужен только фразе о датах.
 *
 * Не тронут роут `/api/tours/[id]/slots` (календарь формы на карточке тура):
 * он считает «сегодня» по `CURRENT_DATE`, и полсуток дата в списке и первая
 * дата календаря могут разойтись на день. Известно и названо.
 *
 * Только сервер. Сторож: tests/integration/public-tour-gate.pg.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { freeSlotsSql, occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { logText } from '@/lib/log/log-text';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * Скалярный подзапрос «ближайшая дата со свободными местами» ('YYYY-MM-DD'
 * текстом или NULL) для тура с алиасом `tourAlias`. Ставится в SELECT-список
 * или в LATERAL. Алиас пишется в коде, а не приходит снаружи.
 */
export function nearestFreeDateSql(tourAlias: string): string {
  if (!ALIAS.test(tourAlias)) {
    throw new Error(`nearestFreeDateSql: недопустимый алиас «${tourAlias}»`);
  }
  const a = tourAlias;
  return `(SELECT ta_nf.date::text
     FROM tour_availability ta_nf
     CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob_nf', day: 'ta_nf.date', tourId: 'ta_nf.operator_tour_id' })}) occ_nf
    WHERE ta_nf.operator_tour_id = ${a}.id
      AND ta_nf.date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date
      AND ta_nf.date <= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + INTERVAL '1 year'
      AND COALESCE(ta_nf.is_cancelled, false) = false
      AND ta_nf.deleted_at IS NULL
      AND ${freeSlotsSql('ta_nf', a, 'occ_nf.taken')} > 0
    ORDER BY ta_nf.date
    LIMIT 1)`;
}

export type NearestDates =
  | {
    state: 'ok';
    byId: Map<string, string | null>;
    /**
     * Свободных мест на эту же ближайшую дату (то же выражение мест, что у
     * самой даты); нет даты — null. Карточка маршрута показывает дату и места
     * из одного источника с порядком (ревью 29.10), а не из вьюхи, где
     * занятость растёт только при оплате.
     */
    seatsById: Map<string, number | null>;
  }
  | { state: 'failed' };

/**
 * Ближайшие свободные даты для уже прочитанных туров — одним запросом.
 * Каждому запрошенному id — дата или null. Отказ базы — `failed` и строка в
 * логе с SQLSTATE: «не смог» не выдаётся за «дат нет» (§4.0).
 */
export async function loadNearestFreeDates(tourIds: readonly (string | number)[]): Promise<NearestDates> {
  const ids = [...new Set(tourIds.map((x) => String(x)).filter((x) => /^\d+$/.test(x)))];
  const byId = new Map<string, string | null>(ids.map((id) => [id, null]));
  const seatsById = new Map<string, number | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return { state: 'ok', byId, seatsById };
  try {
    const { rows } = await pool.query<{ id: string; nearest_free_date: string | null; nearest_free_seats: number | string | null }>(
      `SELECT ot.id::text AS id, nf.d AS nearest_free_date,
              (SELECT MAX(${freeSlotsSql('ta_fs', 'ot', 'occ_fs.taken')})::int
                 FROM tour_availability ta_fs
                 CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob_fs', day: 'ta_fs.date', tourId: 'ta_fs.operator_tour_id' })}) occ_fs
                WHERE ta_fs.operator_tour_id = ot.id
                  AND ta_fs.date = nf.d::date
                  AND COALESCE(ta_fs.is_cancelled, false) = false
                  AND ta_fs.deleted_at IS NULL) AS nearest_free_seats
         FROM operator_tours ot
         CROSS JOIN LATERAL (SELECT ${nearestFreeDateSql('ot')} AS d) nf
        WHERE ot.id = ANY($1::bigint[])`,
      [ids],
    );
    for (const r of rows) {
      byId.set(String(r.id), r.nearest_free_date ?? null);
      const seats = r.nearest_free_seats == null ? null : Number(r.nearest_free_seats);
      seatsById.set(String(r.id), seats != null && Number.isFinite(seats) ? seats : null);
    }
    return { state: 'ok', byId, seatsById };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      '[nearest-free-date] ближайшие даты туров не прочитаны:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
      logText(err instanceof Error ? err.message : err, 200),
    );
    return { state: 'failed' };
  }
}
