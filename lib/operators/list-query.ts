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
 *     (CLAUDE.md §14); прокат автомобилей (`category = 'cars'`, 23.10) — тоже,
 *     его страница — /car-rental/[slug].
 * Живой тур — то же условие, что у каталога и MCP get_tours (шлюз витрины
 * `publicTourSql`), своего здесь нет.
 */

import { z } from 'zod';
import { unstable_cache } from 'next/cache';
import { query } from '@/lib/database';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { sqlState } from '@/lib/guides/db-failure';
import type { OperatorListRow } from '@/lib/types/db-rows';
import { ACTIVITY_ALIASES, canonicalActivity } from '@/lib/tours/labels';
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
    // Прокат автомобилей — не туроператор (23.10): его страница —
    // /car-rental/[slug], машина без водителя за сутки.
    `${alias}.category <> 'cars'`,
  ];
}

const LIVE = publicTourSql('ot');

/**
 * Порядок витрины — одно правило для всех, и оно названо туристу на странице
 * (CLAUDE.md §0, решение владельца 15.10: «мы независимая платформа для
 * туристов в первую очередь и честность наше главное правило»). По алфавиту:
 * правило не зависит ни от чьего слова и ни от каких денег. Рейтинг для
 * порядка не берётся: `partners.rating` пересчитывает триггер по отзывам, но
 * в базе остались числа посевных миграций, и сортировка по ним опиралась бы
 * на возможную выдумку (§4.0).
 */
export { OPERATORS_ORDER_NOTE } from '@/lib/operators/order-note';

/** Все написания вида в базе: канонический ключ и его синонимы (lib/tours/labels). */
function activitySpellings(activity: string): string[] {
  const canon = canonicalActivity(activity);
  return [canon, ...Object.keys(ACTIVITY_ALIASES).filter((k) => ACTIVITY_ALIASES[k] === canon)];
}

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

/**
 * Кнопки фильтра: вид живого тура → сколько компаний списка его водят.
 * Синонимы вида («jeep» и «jeep_safari») сводятся к одному ключу, а компания
 * считается один раз — иначе две одинаковые кнопки и двойной счёт.
 */
async function queryActivityFacets(): Promise<ActivityCount[] | null> {
  try {
    const { rows } = await query<{ activity_type: string; operator_id: string }>(
      `SELECT DISTINCT ot.activity_type, ot.operator_id::text AS operator_id
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
        WHERE ${LIVE}
          AND ot.activity_type IS NOT NULL
          AND ${listedPartner('p').join(' AND ')}`,
    );
    const byKind = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = canonicalActivity(r.activity_type);
      const set = byKind.get(key) ?? new Set<string>();
      set.add(r.operator_id);
      byKind.set(key, set);
    }
    return sortActivityCounts(
      [...byKind].map(([activity_type, ops]) => ({ activity_type, count: ops.size })).filter((r) => r.count > 0),
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
           AND ot.activity_type = ANY($${idx}::text[])
      )`);
    params.push(activitySpellings(activity));
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
       ORDER BY lower(p.name), p.id
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
 * Первые компании витрины для чата (кнопка «Операторы» в Telegram): тот же
 * отбор и тот же порядок, что у /operators, плюс счёт всего списка — чтобы
 * чат мог сказать «первые N из M», а не выдать часть за весь список.
 *
 * `hiddenSlugs` — кого сайт сейчас прячет от людей (пауза проката,
 * lib/rental/site-pause): их нет ни в строках, ни в счёте.
 * Отказ базы бросается — вызывающий говорит «не загрузился», а не «пусто».
 */
export async function queryOperatorLinks(
  limit: number,
  hiddenSlugs: readonly string[] = [],
): Promise<{ items: Array<{ name: string; slug: string }>; total: number }> {
  const where = [...listedPartner('p'), `NOT (p.slug = ANY($1::text[]))`].join(' AND ');
  const [rows, count] = await Promise.all([
    query<{ name: string; slug: string }>(
      `SELECT p.name, p.slug FROM partners p WHERE ${where} ORDER BY lower(p.name), p.id LIMIT $2`,
      [[...hiddenSlugs], limit],
    ),
    query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM partners p WHERE ${where}`,
      [[...hiddenSlugs]],
    ),
  ]);
  const total = parseInt(count.rows[0]?.total ?? '0', 10);
  return { items: rows.rows, total: Math.max(Number.isFinite(total) ? total : 0, rows.rows.length) };
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
