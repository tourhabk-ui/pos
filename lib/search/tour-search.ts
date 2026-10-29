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

import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { compareTourOffers, offerOrderDay } from '@/lib/tours/offer-order';
import { z } from 'zod';
import { unstable_cache } from 'next/cache';
import { pool } from '@/lib/db-pool';
import { tourHeroImageSql } from '@/lib/tours/hero-image';
import { publicTourSql } from '@/lib/tours/public-visibility';

export const MarketplaceToursQuerySchema = z.object({
  search:        z.string().max(200).optional(),
  activity_type: z.string().max(60).optional(),
  location_type: z.string().max(60).optional(),
  // «Новые» (recent) сняты правилом 1в (слово владельца 29.10): новизна в
  // порядок не входит. Старые ссылки `?sort=recent` не ломаются — идут как
  // порядок по правилу.
  sort:          z.enum(['recommended', 'price_asc', 'price_desc', 'recent']).default('recommended')
                   .transform((s) => (s === 'recent' ? 'recommended' : s)),
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
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
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
  /** partners.slug / partners.is_public — страница оператора; закрыта или без адреса — имя текстом (13.10). */
  operator_slug: string | null;
  operator_public: boolean | null;
  bookings_count: number;
  has_availability: boolean;
  /** Ближайшая дата со свободными местами ('YYYY-MM-DD'); нет — null. Ключ правила 1в. */
  nearest_free_date: string | null;
}

export interface MarketplaceToursResult {
  tours: MarketplaceTourRow[];
  /** Сколько туров прошло фильтры — для «показано N из M». */
  total: number;
  /** День правила 1в (дата Камчатки), по которому выстроен жребий. */
  day?: string;
}

/**
 * «У тура есть свободные даты» — одно условие для витрин (ленты площадок).
 *
 * С 29.10 каталог и главная (app/_home/data.ts, fetchPlates) берут саму
 * ближайшую свободную дату (nearestFreeDateSql) — по ней строится порядок, а
 * «даты есть» выводится из неё: то же условие, без второго подзапроса. Первая
 * редакция П4 (24.09) держала там ручную копию этого EXISTS — правка условия
 * здесь развела бы витрины для одного и того же тура, как с «13 турами»
 * (#1780). Сторож: tests/unit/home-plates-tours.test.ts.
 *
 * Алиас тура — `ot` (как у листинга каталога).
 *
 * С 29.10 (правило 1в) условие — та же «ближайшая свободная дата», по которой
 * строится порядок витрин (lib/tours/nearest-free-date): «сегодня» по Камчатке,
 * горизонт в год, вместимость не больше `max_participants`. До этого здесь
 * была своя копия по `CURRENT_DATE` без потолка мест, и тур мог быть «с
 * датами» в каталоге и «без дат» в каталоге Кузьмича.
 */
export function hasAvailabilitySql(): string {
  return `(${nearestFreeDateSql('ot')} IS NOT NULL)`;
}

export async function queryMarketplaceTours(filters: MarketplaceToursFilters): Promise<MarketplaceToursResult> {
  const {
    search, activity_type, location_type, sort,
    difficulty, duration_type, price_min, price_max,
    id, limit, offset,
  } = filters;

  const selectFields = `
      ot.id,
      ot.slug,
      ot.title,
      ot.description,
      ot.short_description,
      ot.base_price,
      ot.price_old,
      ot.price_unit,
      ot.activity_type,
      ot.location_type,
      ot.location_name,
      -- Главный кадр — первый кадр галереи, как в карточке тура (lib/tours/hero-image).
      ${tourHeroImageSql('ot')} AS tour_image,
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
      p.slug as operator_slug,
      p.is_public as operator_public,
      COUNT(ob.id)::INT as bookings_count,
      -- Ключ порядка (правило 1в) и «есть даты» — одно условие,
      -- lib/tours/nearest-free-date: has_availability выводится из него в TS.
      ${nearestFreeDateSql('ot')} AS nearest_free_date`;

  const from = `
    FROM operator_tours ot
    JOIN partners p ON ot.operator_id = p.id
    LEFT JOIN operator_bookings ob ON ob.operator_tour_id = ot.id`;

  // Живой тур витрины — шлюз publicTourSql: одно условие на листинг, сводку
  // (queryCatalogSummary), главную и витрину компаний. Две копии условия дали
  // бы герою «8 туров», а сетке другое число, как уже было с константой
  // «13 туров» (#1780). До 15.10 здесь жил второй канон того же правила —
  // LIVE_TOUR_CONDITIONS с теми же тремя флагами; два канона расходятся при
  // первой правке одного из них, поэтому он снят (находка аудита 15.10 P1-04).
  const conditions: string[] = [publicTourSql('ot')];
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

  // Порядок — правило 1в, в TypeScript (lib/tours/offer-order), а не в
  // ORDER BY: второй копии правила в SQL нет. До 29.10 здесь стояло
  // `has_availability DESC, created_at DESC` — новизна поднимала свежие туры,
  // и «показано 50» резало хвост без продолжения. Живых туров на витрине —
  // десятки, загрузить все и отрезать страницу в памяти дешевле, чем держать
  // два правила.
  const dataQuery = `
    SELECT ${selectFields} ${from} ${where}
    GROUP BY ot.id, p.id`;

  const day = offerOrderDay();
  const { rows } = await pool.query<MarketplaceTourRow>(dataQuery, params);
  const all = orderMarketplaceTours(
    rows.map((r) => ({ ...r, has_availability: r.nearest_free_date != null })),
    sort,
    day,
  );

  return {
    tours: all.slice(offset, offset + limit),
    total: all.length,
    day,
  };
}

/**
 * Порядок выдачи каталога. `recommended` — правило 1в как есть. Цена — только
 * когда её выбрал турист (кнопка с подписью SORT_CHOICE_NOTE_RU), и равные
 * цены идут тем же правилом, а не по названию. Цена без записи (null) — в
 * конце при любом направлении: «не знаем» не дешевле и не дороже.
 */
export function orderMarketplaceTours<T extends { id: number | string; base_price: number | string | null; nearest_free_date: string | null }>(
  rows: readonly T[],
  sort: MarketplaceToursFilters['sort'],
  day: string,
): T[] {
  const rule = compareTourOffers(day);
  const byRule = (a: T, b: T) => rule(
    { id: a.id, nearestFreeDate: a.nearest_free_date },
    { id: b.id, nearestFreeDate: b.nearest_free_date },
  );
  const price = (r: T): number | null => {
    if (r.base_price == null) return null;
    const n = Number(r.base_price);
    return Number.isFinite(n) ? n : null;
  };
  if (sort === 'price_asc' || sort === 'price_desc') {
    const dir = sort === 'price_asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const pa = price(a);
      const pb = price(b);
      if ((pa === null) !== (pb === null)) return pa === null ? 1 : -1;
      if (pa !== null && pb !== null && pa !== pb) return (pa - pb) * dir;
      return byRule(a, b);
    });
  }
  return [...rows].sort(byRule);
}

/**
 * Вариант для серверного рендера листинга: кэш 600с на комбинацию фильтров.
 * Поисковые запросы идут мимо кэша — множество ключей не ограничено.
 */
export async function queryMarketplaceToursForPage(filters: MarketplaceToursFilters): Promise<MarketplaceToursResult> {
  if (filters.search) return queryMarketplaceTours(filters);
  return unstable_cache(
    () => queryMarketplaceTours(filters),
    // v2: строка получила operator_verified (аудит П5); v3 — operator_slug и
    // operator_public (ссылка на страницу оператора, 13.10). Смена формы
    // строки — смена ключа, иначе кэш 600с отдаёт карточке строки без поля.
    // v4 — правило 1в (29.10): строка несёт nearest_free_date, а в ключе стоит
    // день Камчатки — иначе после полуночи до 10 минут стоял бы вчерашний жребий.
    ['marketplace-tours-query-v4', offerOrderDay(), JSON.stringify(filters)],
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
      WHERE ${publicTourSql('ot')}
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
