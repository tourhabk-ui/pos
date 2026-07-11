/**
 * Общий data-слой публичного каталога операторов.
 *
 * Используется двумя потребителями (шаг 3 аудита 11.07 — SSR-листинги):
 *   - GET /api/operators (клиентские рефетчи при смене фильтров);
 *   - app/operators/page.tsx (серверный первый рендер — контент в первом HTML).
 * Логика перенесена из app/api/operators/route.ts без изменений поведения.
 */

import { z } from 'zod';
import { unstable_cache } from 'next/cache';
import { query } from '@/lib/database';
import type { OperatorListRow } from '@/lib/types/db-rows';

export const OperatorsQuerySchema = z.object({
  category: z.string().max(60).optional(),
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
}

export interface OperatorsResult {
  items: OperatorListItem[];
  meta: { total: number; page: number; limit: number; pages: number };
}

export async function queryOperators(filters: OperatorsFilters): Promise<OperatorsResult> {
  const { category, search, page, limit } = filters;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['is_public = TRUE', 'slug IS NOT NULL'];
  const params: unknown[] = [];
  let idx = 1;

  if (category) {
    conditions.push(`category = $${idx}`);
    params.push(category);
    idx++;
  }
  if (search) {
    conditions.push(`(name ILIKE $${idx} OR short_description ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [dataRes, countRes] = await Promise.all([
    query<OperatorListRow>(
      `SELECT id, slug, name, category, short_description, hero_image,
              rating::text, review_count::text, is_verified
       FROM partners
       ${where}
       ORDER BY rating DESC, review_count DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM partners ${where}`,
      params
    ),
  ]);

  const total = parseInt(countRes.rows[0]?.total ?? '0');

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
    })),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
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
    ['operators-query', JSON.stringify(filters)],
    { revalidate: 600 }
  )();
}
