/**
 * ПОИСК · фильтр-поиск публичного каталога туров (operator_tours).
 *
 * Часть движка «Поиск» (`lib/search`). Консолидация июль 2026: перемещено из
 * `lib/tours/marketplace-query.ts` без изменения поведения.
 *
 * Потребители:
 *   - GET /api/hub/marketplace/tours (клиентские рефетчи при смене фильтров);
 *   - app/catalog/page.tsx и app/marketplace/page.tsx (серверный первый рендер).
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { z } from 'zod';
import { unstable_cache } from 'next/cache';
import { pool } from '@/lib/db-pool';

export const MarketplaceToursQuerySchema = z.object({
  search:        z.string().max(200).optional(),
  activity_type: z.string().max(60).optional(),
  location_type: z.string().max(60).optional(),
  sort:          z.enum(['recommended', 'price_asc', 'price_desc', 'recent']).default('recommended'),
  difficulty:    z.enum(['easy', 'medium', 'hard']).optional(),
  duration_type: z.enum(['day', 'half_day', 'multi_day']).optional(),
  price_min:     z.coerce.number().min(0).optional(),
  price_max:     z.coerce.number().min(0).optional(),
  id:            z.coerce.number().int().optional(),
  limit:         z.coerce.number().int().min(1).max(100).default(50),
  offset:        z.coerce.number().int().min(0).default(0),
});

export type MarketplaceToursFilters = z.infer<typeof MarketplaceToursQuerySchema>;

export interface MarketplaceTourRow {
  id: number;
  title: string;
  description: string;
  short_description: string | null;
  base_price: number;
  price_old: number | null;
  price_unit: string | null;
  activity_type: string;
  location_type: string;
  location_name: string | null;
  tour_image: string | null;
  max_participants: number | null;
  duration_hours: number | null;
  duration_type: string | null;
  multi_day_count: number | null;
  difficulty: string | null;
  included: string[] | null;
  season_start: string | null;
  season_end: string | null;
  operator_name: string;
  operator_id: string;
  /**
   * `partners.is_verified` как есть: true — проверен, false — нет, null — в
   * записи не установлено. Карточка каталога пишет «проверен» ТОЛЬКО при true
   * (§4.0): безусловная отметка была бы обещанием без источника.
   */
  operator_verified: boolean | null;
  bookings_count: number;
  has_availability: boolean;
}

export interface MarketplaceToursResult {
  tours: MarketplaceTourRow[];
  total: number;
}

/**
 * Что считается живым туром витрины — одно условие на листинг и на сводку
 * (`queryCatalogSummary`). Две копии условия дали бы герою «8 туров», а сетке
 * другое число, как уже было с константой «13 туров» (#1780).
 */
export const LIVE_TOUR_CONDITIONS = [
  'ot.deleted_at IS NULL',
  'ot.is_active = true',
  'ot.is_published = true',
] as const;

/**
 * «У тура есть свободные даты» — одно условие для каталога и главной.
 *
 * Главная (app/_home/data.ts, fetchPlates) решает по нему «даты есть / по
 * запросу / сезон кончился» тем же правилом catalogAvailability. Первая
 * редакция П4 (24.09) держала там ручную копию этого EXISTS — правка условия
 * здесь развела бы витрины для одного и того же тура, как с «13 турами»
 * (#1780). Сторож: tests/unit/home-plates-tours.test.ts.
 *
 * Алиас тура — `ot` (как в LIVE_TOUR_CONDITIONS); брони внутри — `ob2`,
 * чтобы не спорить с внешним `ob` листинга.
 */
export function hasAvailabilitySql(): string {
  return `EXISTS (
        SELECT 1 FROM tour_availability ta
        WHERE ta.operator_tour_id = ot.id
          AND ta.date >= CURRENT_DATE
          AND ta.deleted_at IS NULL
          AND ta.is_cancelled = false
          AND ta.available_slots > (${occupiedOnDaySql({ booking: 'ob2', day: 'ta.date', tourId: 'ot.id' })}
          )
      )`;
}

export async function queryMarketplaceTours(filters: MarketplaceToursFilters): Promise<MarketplaceToursResult> {
  const {
    search, activity_type, location_type, sort,
    difficulty, duration_type, price_min, price_max,
    id, limit, offset,
  } = filters;

  const selectFields = `
      ot.id,
      ot.title,
      ot.description,
      ot.short_description,
      ot.base_price,
      ot.price_old,
      ot.price_unit,
      ot.activity_type,
      ot.location_type,
      ot.location_name,
      ot.tour_image,
      ot.max_participants,
      ot.duration_hours,
      ot.duration_type,
      ot.multi_day_count,
      ot.difficulty,
      ot.included,
      ot.season_start,
      ot.season_end,
      p.name as operator_name,
      p.id as operator_id,
      p.is_verified as operator_verified,
      COUNT(ob.id)::INT as bookings_count,
      ${hasAvailabilitySql()} as has_availability`;

  const from = `
    FROM operator_tours ot
    JOIN partners p ON ot.operator_id = p.id
    LEFT JOIN operator_bookings ob ON ob.operator_tour_id = ot.id`;

  const conditions: string[] = [...LIVE_TOUR_CONDITIONS];
  const params: unknown[] = [];
  let idx = 1;

  if (id != null) {
    conditions.push(`ot.id = $${idx++}`);
    params.push(id);
  }
  if (activity_type) {
    conditions.push(`ot.activity_type = $${idx++}`);
    params.push(activity_type);
  }
  if (location_type) {
    conditions.push(`ot.location_type = $${idx++}`);
    params.push(location_type);
  }
  if (difficulty) {
    conditions.push(`ot.difficulty = $${idx++}`);
    params.push(difficulty);
  }
  if (duration_type) {
    conditions.push(`ot.duration_type = $${idx++}`);
    params.push(duration_type);
  }
  if (price_min != null) {
    conditions.push(`ot.base_price >= $${idx++}`);
    params.push(price_min);
  }
  if (price_max != null) {
    conditions.push(`ot.base_price <= $${idx++}`);
    params.push(price_max);
  }
  if (search) {
    conditions.push(`(ot.title ILIKE $${idx} OR ot.description ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const orderBy =
    sort === 'price_asc'  ? 'ot.base_price ASC, ot.title ASC' :
    sort === 'price_desc' ? 'ot.base_price DESC, ot.title ASC' :
    sort === 'recent'     ? 'ot.created_at DESC' :
    /* recommended */       'has_availability DESC, ot.created_at DESC';

  const dataQuery = `
    SELECT ${selectFields} ${from} ${where}
    GROUP BY ot.id, p.id
    ORDER BY ${orderBy}
    LIMIT $${idx++} OFFSET $${idx++}`;
  const dataParams = [...params, limit, offset];

  const countQuery = `
    SELECT COUNT(DISTINCT ot.id)::INT as total
    ${from} ${where}`;

  const [dataResult, countResult] = await Promise.all([
    pool.query<MarketplaceTourRow>(dataQuery, dataParams),
    pool.query<{ total: number }>(countQuery, params),
  ]);

  return {
    tours: dataResult.rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}

/**
 * Вариант для серверного рендера листинга: кэш 600с на комбинацию фильтров.
 * Поисковые запросы идут мимо кэша — множество ключей не ограничено.
 */
export async function queryMarketplaceToursForPage(filters: MarketplaceToursFilters): Promise<MarketplaceToursResult> {
  if (filters.search) return queryMarketplaceTours(filters);
  return unstable_cache(
    () => queryMarketplaceTours(filters),
    // v2: строка получила operator_verified (аудит П5). Смена формы строки —
    // смена ключа, иначе кэш 600с отдаёт карточке строки без поля.
    ['marketplace-tours-query-v2', JSON.stringify(filters)],
    { revalidate: 600 }
  )();
}

/**
 * Сводка витрины для первого экрана каталога: сколько живых туров, от какой
 * цены и сколько по каждому направлению. Считается на сервере одним запросом
 * без фильтров — чтобы в первом кадре стояло число из данных, а не «—» до
 * второго клиентского запроса и не константа (аудит П5, #130/#137).
 *
 * Направления без единого тура сюда не попадают по построению (GROUP BY по
 * существующим турам): мёртвых чипов витрина нарисовать не может.
 */
export interface CatalogSummary {
  total: number;
  /** null — туров нет, минимальной цены не существует. */
  minPrice: number | null;
  byActivity: { activity_type: string; count: number }[];
}

export async function queryCatalogSummary(): Promise<CatalogSummary> {
  const { rows } = await pool.query<{ activity_type: string | null; n: number; min_price: string | number | null }>(
    `SELECT ot.activity_type, COUNT(*)::INT AS n, MIN(ot.base_price) AS min_price
       FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
      WHERE ${LIVE_TOUR_CONDITIONS.join(' AND ')}
      GROUP BY ot.activity_type
      ORDER BY n DESC, ot.activity_type ASC`,
  );
  return summarizeCatalogRows(rows);
}

/** Чистая свёртка строк GROUP BY — отдельно, чтобы её держал тест без БД. */
export function summarizeCatalogRows(
  rows: { activity_type: string | null; n: number; min_price: string | number | null }[],
): CatalogSummary {
  let total = 0;
  let minPrice: number | null = null;
  const byActivity: CatalogSummary['byActivity'] = [];
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    const price = r.min_price == null ? null : Number(r.min_price);
    if (price != null && Number.isFinite(price) && (minPrice == null || price < minPrice)) minPrice = price;
    if (r.activity_type && n > 0) byActivity.push({ activity_type: r.activity_type, count: n });
  }
  return { total, minPrice, byActivity };
}

/** Сводка для RSC-страницы каталога: кэш 600с, как у листинга. */
export async function queryCatalogSummaryForPage(): Promise<CatalogSummary> {
  return unstable_cache(() => queryCatalogSummary(), ['catalog-summary'], { revalidate: 600 })();
}
