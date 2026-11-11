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
import { publicTourSql } from '@/lib/tours/public-visibility';

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

/**
 * То же условие в окне дат поездки: ближайшая дата со свободными местами не
 * раньше начала окна (и не раньше сегодняшнего дня по Камчатке) и не позже
 * его конца. Планировщик (аудит 07.11, E5) упорядочивает туры зоны по
 * выезду в дни поездки, а не по ближайшему выезду вообще: иначе срез по числу
 * дней блока отрезал туры с датами в поездке раньше, чем движок смотрел
 * окно, — их место занимали туры с выездами в другие месяцы.
 *
 * `fromParam`, `toParam` — номера параметров запроса (`$3`) с датами
 * 'YYYY-MM-DD'; значения — только параметрами, не строкой в SQL.
 */
export function nearestFreeDateInWindowSql(tourAlias: string, fromParam: string, toParam: string): string {
  if (!ALIAS.test(tourAlias) || !/^\$\d+$/.test(fromParam) || !/^\$\d+$/.test(toParam)) {
    throw new Error(`nearestFreeDateInWindowSql: недопустимый алиас или параметр (${tourAlias}, ${fromParam}, ${toParam})`);
  }
  const a = tourAlias;
  return `(SELECT ta_nw.date::text
     FROM tour_availability ta_nw
     CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob_nw', day: 'ta_nw.date', tourId: 'ta_nw.operator_tour_id' })}) occ_nw
    WHERE ta_nw.operator_tour_id = ${a}.id
      AND ta_nw.date >= GREATEST(${fromParam}::date, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date)
      AND ta_nw.date <= ${toParam}::date
      AND COALESCE(ta_nw.is_cancelled, false) = false
      AND ta_nw.deleted_at IS NULL
      AND ${freeSlotsSql('ta_nw', a, 'occ_nw.taken')} > 0
    ORDER BY ta_nw.date
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

/**
 * Годы, на которые у туров витрины есть свободная дата, — по тому же
 * условию, что ближайшая свободная дата: от сегодняшнего дня по Камчатке
 * на год вперёд, строка календаря жива, место есть. Окно в год накрывает
 * не больше двух календарных лет, и каждый проверяется одним EXISTS.
 *
 * Для заголовков витрин (владелец 11.11: «туры на Камчатку 2026? там же есть
 * и 2027»): год в заголовке стоял числом в коде и в ноябре звал в сезон,
 * который уже кончился. Тур без календаря («даты по заявке») года не даёт:
 * сезон оператора — не дата.
 *
 * `activityType` — только туры этого вида (посадочная «Рыбалка»).
 * Отказ базы — null и строка в логе с SQLSTATE: заголовок тогда без года,
 * а не с выдуманным (§4.0).
 */
export async function loadOpenDateYears(opts: { activityType?: string } = {}): Promise<number[] | null> {
  try {
    const { rows } = await pool.query<{ y: number | string }>(
      `WITH today AS (SELECT (NOW() AT TIME ZONE 'Asia/Kamchatka')::date AS d)
       SELECT yr.y
         FROM today
         CROSS JOIN LATERAL (VALUES (EXTRACT(YEAR FROM today.d)::int), (EXTRACT(YEAR FROM today.d)::int + 1)) AS yr(y)
        WHERE EXISTS (
          SELECT 1
            FROM operator_tours ot
            JOIN tour_availability ta_y ON ta_y.operator_tour_id = ot.id
            CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob_y', day: 'ta_y.date', tourId: 'ta_y.operator_tour_id' })}) occ_y
           WHERE ${publicTourSql('ot')}
             AND ($1::text IS NULL OR ot.activity_type::text = $1::text)
             AND ta_y.date >= GREATEST(today.d, make_date(yr.y, 1, 1))
             AND ta_y.date <= LEAST((today.d + INTERVAL '1 year')::date, make_date(yr.y, 12, 31))
             AND COALESCE(ta_y.is_cancelled, false) = false
             AND ta_y.deleted_at IS NULL
             AND ${freeSlotsSql('ta_y', 'ot', 'occ_y.taken')} > 0)
        ORDER BY yr.y`,
      [opts.activityType ?? null],
    );
    return rows.map((r) => Number(r.y)).filter((y) => Number.isInteger(y));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      '[nearest-free-date] годы свободных дат не прочитаны:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
      logText(err instanceof Error ? err.message : err, 200),
    );
    return null;
  }
}

/**
 * Годы словами для заголовка: [] или null — пусто (года нет, а не выдуманный),
 * [2026] — «2026», [2026, 2027] — «2026–2027».
 */
export function openYearsLabel(years: readonly number[] | null): string {
  if (!years || years.length === 0) return '';
  const sorted = [...years].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return first === last ? String(first) : `${first}–${last}`;
}
