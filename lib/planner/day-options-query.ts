/**
 * lib/planner/day-options-query.ts — туры для «Сравнить и заменить» и «План Б»
 * (супер-планер, 22.11). Сервер: читает каталог и места на дату из базы.
 *
 *  - `same`   — другие туры того же вида на дату дня (в зоне дня; нет в зоне —
 *               из других зон, с пометкой «другая зона»);
 *  - `ground` — туры той же зоны на дату дня, которые не решает лётная и
 *               морская погода (замена дня с вертолётом, морем, вулканом).
 *
 * Туры на один день: день многодневного тура этим не заменяется. Отбор по дате
 * — правило движка (`catalogRowFitsDay`), порядок — правило 1в
 * (`orderOffersBy`), не «дешевле выше». Места и цена на дату для группы —
 * `rereadTourDay` на каждый вариант, тем же путём, что после перестановки дней;
 * ничего не кэшируется. Отказ чтения одного варианта — его `read: null`
 * («не прочитали»), а не «мест нет».
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateInWindowSql, nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { anyDayOpenSql } from '@/lib/tours/schedule-kind';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { catalogRowFitsDay } from './tour-day-fit';
import { kamchatkaToday } from './calendar-days';
import { zoneMatchSql } from './zone-match';
import { rawTypesFor } from './constants';
import { tourPlanSpan } from './tour-span';
import { rereadTourDay } from './tour-day-reread';
import { WEATHER_SENSITIVE_TYPES, weatherKindOfActivity } from './weather-plan-b';
import type { DayOption } from './day-options';

export interface DayOptionsInput {
  mode: 'same' | 'ground';
  /** Вид занятия дня (ключ движка); для `ground` не нужен. */
  activityType?: string;
  zone: string;
  date: string;
  participants: number;
  /** Тур, который сейчас стоит в дне: в варианты не попадает. */
  excludeTourId?: string;
  limit: number;
}

interface Row {
  id: string;
  title: string;
  short_description: string | null;
  base_price: string | null;
  price_unit: string | null;
  activity_type: string | null;
  difficulty: string | null;
  min_participants: number | null;
  max_participants: number | null;
  group_size_unlimited: boolean;
  duration_hours: number | null;
  multi_day_count: number | null;
  duration_type: string | null;
  season_start: string | null;
  season_end: string | null;
  keeps_schedule: boolean;
  free_on_date: string | null;
  nearest_free_date: string | null;
  any_day_open: boolean | null;
  lat: number | null;
  lng: number | null;
  operator_name: string;
  operator_slug: string;
}

const SELECT = `
  SELECT
    ot.id::text AS id, ot.title, ot.short_description, ot.base_price::text AS base_price, ot.price_unit,
    ot.activity_type, ot.difficulty, ot.min_participants, ot.max_participants,
    COALESCE(ot.group_size_unlimited, FALSE) AS group_size_unlimited,
    ot.duration_hours::float8 AS duration_hours, ot.multi_day_count, ot.duration_type,
    ot.season_start::text AS season_start, ot.season_end::text AS season_end,
    ${keepsScheduleSql('ot.id')} AS keeps_schedule,
    ${nearestFreeDateInWindowSql('ot', '$1', '$1')} AS free_on_date,
    ${nearestFreeDateSql('ot')} AS nearest_free_date,
    ${anyDayOpenSql('ot')} AS any_day_open,
    ot.latitude::float8 AS lat, ot.longitude::float8 AS lng,
    p.name AS operator_name, p.slug AS operator_slug
  FROM operator_tours ot
  JOIN partners p ON p.id = ot.operator_id
  LEFT JOIN (
    -- Зона маршрута тура — из master-таблиц, не из VIEW agent_route_knowledge
    -- (CLAUDE.md §4.1): те же id, zone и lat, что VIEW (миграция 942).
    SELECT pl.ark_id AS id, pl.zone, pl.lat FROM places pl WHERE pl.merged_into_id IS NULL
    UNION ALL
    SELECT COALESCE(kr.ark_id, kr.id) AS id, kr.zone, kr.lat FROM kamchatka_routes kr WHERE kr.merged_into_id IS NULL
  ) ark ON ark.id = ot.agent_route_id`;

async function readRows(input: DayOptionsInput, inZone: boolean): Promise<Row[]> {
  // $1 — дата дня, $2 — виды, $3 — исключённый тур, $4 — зона.
  const typeCond = input.mode === 'same'
    ? 'ot.activity_type = ANY($2::text[])'
    : 'ot.activity_type IS NOT NULL AND NOT (ot.activity_type = ANY($2::text[]))';
  const types = input.mode === 'same' ? rawTypesFor(input.activityType ?? '') : [...WEATHER_SENSITIVE_TYPES];
  const params: unknown[] = [input.date, types, input.excludeTourId ?? ''];
  let zoneCond = '';
  if (inZone) {
    params.push(input.zone);
    zoneCond = `AND ${zoneMatchSql('ark', '$4')}`;
  }
  const { rows } = await pool.query<Row>(`${SELECT}
    WHERE ${typeCond}
      AND ${publicTourSql('ot')}
      AND p.is_public = TRUE
      AND ot.id::text <> $3::text
      ${zoneCond}`, params);
  return rows;
}

/** Строки, которые подходят дню: выезд в эту дату, тур на один день, правило 1в; оператор на витрине. */
function pick(rows: readonly Row[], input: DayOptionsInput): Row[] {
  const { date, limit } = input;
  const today = kamchatkaToday();
  const fit = rows.filter((r) => catalogRowFitsDay(r, date, today)
    && tourPlanSpan(r.duration_hours, r.multi_day_count) === 1
    // Замена «на земле»: вид у операторов записан по-разному — облёт,
    // катер, восхождение узнаются и по названию (ревью #3708).
    && (input.mode !== 'ground' || weatherKindOfActivity(r.activity_type ?? '', r.title) === null));
  return orderOffersBy(fit, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null, anyDayOpen: r.any_day_open ?? null }))
    .slice(0, limit);
}

/** Варианты дня с местами и ценой на дату для группы. */
export async function dayOptions(input: DayOptionsInput): Promise<DayOption[]> {
  let rows = pick(await readRows(input, true), input);
  let otherZone = false;
  if (rows.length === 0 && input.mode === 'same') {
    rows = pick(await readRows(input, false), input);
    otherZone = rows.length > 0;
  }
  return Promise.all(rows.map(async (r): Promise<DayOption> => {
    // Группа без потолка (аудит E3): лимита нет — и места, и цена без него.
    const cap = r.group_size_unlimited ? null : r.max_participants ?? null;
    const read = await rereadTourDay({
      tourId: r.id, date: input.date, participants: input.participants,
      maxParticipants: cap,
    }).catch((err: unknown) => {
      const e = err as { code?: string; message?: string } | undefined;
      console.error('[planner/day-options] места и цена варианта не прочитаны', { tourId: r.id, sqlstate: e?.code ?? null, message: e?.message ?? null });
      return null;
    });
    const price = r.base_price === null ? NaN : Number(r.base_price);
    return {
      id: r.id,
      title: r.title,
      shortDescription: r.short_description,
      activityType: r.activity_type ?? '',
      operatorName: r.operator_name,
      operatorSlug: r.operator_slug,
      basePrice: Number.isFinite(price) && price > 0 ? price : null,
      priceUnit: r.price_unit,
      minParticipants: r.min_participants,
      maxParticipants: cap,
      calendar: r.keeps_schedule ? 'dated' : 'request',
      otherZone,
      difficulty: r.difficulty,
      coords: typeof r.lat === 'number' && typeof r.lng === 'number' && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? [r.lat, r.lng] : null,
      read,
    };
  }));
}
