/**
 * Общий data-слой публичного каталога операторов.
 *
 * Используется двумя потребителями (шаг 3 аудита 11.07 — SSR-листинги):
 *   - GET /api/operators (клиентские рефетчи при смене фильтров);
 *   - app/operators/page.tsx (серверный первый рендер — контент в первом HTML).
 *
 * Аудит 15.10, находка PAVEL-operators (жалоба «Местечка Камчатка»: «я там не
 * выделяюсь, у меня основное — вертолётные экскурсии»):
 *   - у карточки — факты о живых турах компании (`tourFacts`, строка
 *     «15 туров · Джип-сафари 8 · Вертолёт 5 · Снегоход 2»);
 *   - фильтр — по виду живого тура (`activity`), а не по `partners.category`:
 *     прежние кнопки «Рыбалка», «Вертолётные туры» фильтровали колонку, CHECK
 *     которой допускает только роли (operator, guide, transfer…), и всегда
 *     давали «Операторы не найдены» — объявление без производителя (10.09);
 *   - перевозчики (`category = 'transfer'`) в список «Операторы Камчатки» не
 *     входят: перевозчик не туроператор, его страница — /transfers/[slug]
 *     (CLAUDE.md §14).
 * Живой тур — то же условие, что у каталога и MCP get_tours
 * (`LIVE_TOUR_CONDITIONS`), своего здесь нет.
 */

import { z } from 'zod';
import { unstable_cache } from 'next/cache';
import { query } from '@/lib/database';
import { LIVE_TOUR_CONDITIONS } from '@/lib/search/tour-search';
import { sqlState } from '@/lib/guides/db-failure';
import type { OperatorListRow } from '@/lib/types/db-rows';
import {
  sortActivityCounts,
  summarizeOperatorTourRows,
  type ActivityCount,
  type OperatorTourFacts,
} from '@/lib/operators/tour-facts';

/** Ключ вида тура: тот же алфавит, что у `operator_tours.activity_type`. */
export const ACTIVITY_KEY = /^[a-z_]{1,40}$/;

// Прежний параметр `category` из схемы убран: zod его отбрасывает, и старая
// ссылка `/operators?category=fishing` открывает список без фильтра, а не
// пустую выдачу (находка PAVEL-operators, 15.10).
export const OperatorsQuerySchema = z.object({
  activity: z.string().regex(ACTIVITY_KEY).optional(),
  search:   z.string().max(200).optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(50).default(20),
});

export type OperatorsFilters = z.infer<typeof OperatorsQuerySchema>;

export interface OperatorListItem {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  shortDescription: string | null;
  heroImage: string | null;
  rating: number;
  reviewCount: number;
  isVerified: boolean;
  /** Живые туры компании; `null` — посчитать не удалось (отказ в логе). */
  tourFacts: OperatorTourFacts | null;
}

export interface OperatorsResult {
  items: OperatorListItem[];
  meta: { total: number; page: number; limit: number; pages: number };
  /**
   * Виды живых туров и сколько компаний списка их водит — кнопки фильтра.
   * Считается без фильтров страницы. `null` — посчитать не удалось: кнопок
   * нет, а не «ни одного вида».
   */
  activities: ActivityCount[] | null;
}

/**
 * Кто входит в список «Операторы Камчатки». Одно определение на выдачу,
 * счёт и кнопки фильтра — иначе «Вертолёт · 2» на кнопке и выдача по ней
 * разошлись бы, как «13 туров» каталога (#1780).
 */
function listedPartner(alias: string): string[] {
  return [
    `${alias}.is_public = TRUE`,
    `${alias}.slug IS NOT NULL`,
    `${alias}.category <> 'transfer'`,
  ];
}

const LIVE = LIVE_TOUR_CONDITIONS.join(' AND ');

/** Отказ вспомогательного запроса называется вслух (§4.0): имя и SQLSTATE. */
function logListFailure(name: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[operators] ${name} не выполнился: sqlstate=${sqlState(err)}`, msg);
}

/** Факты о живых турах для компаний страницы — один агрегат на всю страницу. */
async function queryTourFacts(ids: string[]): Promise<Map<string, OperatorTourFacts> | null> {
  if (ids.length === 0) return new Map();
  try {
    const { rows } = await query<{ operator_id: string; activity_type: string | null; n: number }>(
      `SELECT ot.operator_id::text AS operator_id, ot.activity_type, COUNT(*)::int AS n
         FROM operator_tours ot
        WHERE ${LIVE}
          AND ot.operator_id = ANY($1::uuid[])
        GROUP BY ot.operator_id, ot.activity_type`,
      [ids],
    );
    return summarizeOperatorTourRows(rows);
  } catch (err) {
    logListFailure('operators-tour-facts', err);
    return null;
  }
}

/** Кнопки фильтра: вид живого тура → сколько компаний списка его водят. */
async function queryActivityFacets(): Promise<ActivityCount[] | null> {
  try {
    const { rows } = await query<{ activity_type: string; n: number }>(
      `SELECT ot.activity_type, COUNT(DISTINCT ot.operator_id)::int AS n
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
        WHERE ${LIVE}
          AND ot.activity_type IS NOT NULL
          AND ${listedPartner('p').join(' AND ')}
        GROUP BY ot.activity_type`,
    );
    return sortActivityCounts(
      rows.map((r) => ({ activity_type: r.activity_type, count: Number(r.n) })).filter((r) => r.count > 0),
    );
  } catch (err) {
    logListFailure('operators-activity-facets', err);
    return null;
  }
}

export async function queryOperators(filters: OperatorsFilters): Promise<OperatorsResult> {
  const { activity, search, page, limit } = filters;
  const offset = (page - 1) * limit;

  const conditions: string[] = listedPartner('p');
  const params: unknown[] = [];
  let idx = 1;

  if (activity) {
    conditions.push(`EXISTS (
        SELECT 1 FROM operator_tours ot
         WHERE ot.operator_id = p.id
           AND ${LIVE}
           AND ot.activity_type = $${idx}
      )`);
    params.push(activity);
    idx++;
  }
  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.short_description ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [dataRes, countRes, activities] = await Promise.all([
    query<OperatorListRow>(
      `SELECT p.id, p.slug, p.name, p.category, p.short_description, p.hero_image,
              p.rating::text, p.review_count::text, p.is_verified
       FROM partners p
       ${where}
       ORDER BY p.rating DESC, p.review_count DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM partners p ${where}`,
      params
    ),
    queryActivityFacets(),
  ]);

  const total = parseInt(countRes.rows[0]?.total ?? '0');
  const facts = await queryTourFacts(dataRes.rows.map((r) => r.id));

  return {
    items: dataRes.rows.map(r => ({
      id:               r.id,
      slug:             r.slug,
      name:             r.name,
      category:         r.category,
      shortDescription: r.short_description,
      heroImage:        r.hero_image,
      rating:           parseFloat(r.rating ?? '0'),
      reviewCount:      parseInt(r.review_count ?? '0'),
      isVerified:       r.is_verified,
      // Отказ запроса фактов — null у всех; компания без живых туров — ноль.
      tourFacts:        facts === null ? null : (facts.get(r.id) ?? { total: 0, byActivity: [] }),
    })),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
    activities,
  };
}

/**
 * Вариант для серверного рендера листинга: кэш 600с на комбинацию фильтров.
 * Поисковые запросы идут мимо кэша — множество ключей не ограничено.
 */
export async function queryOperatorsForPage(filters: OperatorsFilters): Promise<OperatorsResult> {
  if (filters.search) return queryOperators(filters);
  return unstable_cache(
    () => queryOperators(filters),
    // v2: строка получила tourFacts, ответ — activities (15.10). Смена формы —
    // смена ключа, иначе кэш 600 с отдал бы карточкам строки без полей.
    ['operators-query-v2', JSON.stringify(filters)],
    { revalidate: 600 }
  )();
}
