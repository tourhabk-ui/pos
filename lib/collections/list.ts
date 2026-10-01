/**
 * Список публичных подборок — один загрузчик для /collections и
 * GET /api/collections.
 *
 * До 01.10 страница была оболочкой и тянула список из API в браузере:
 * поисковик видел 21–23 слова вместо подборок (аудит vedarai.ru 01.10).
 *
 * Размер подборки честный: правило → COUNT каталога, иначе — массивы
 * (lib/collections/resolve). Пустая подборка не показывается: лучше её нет,
 * чем «Вулканы Камчатки → 0».
 */
import { pool } from '@/lib/db-pool';
import { resolveCollectionCount, type CollectionRow } from '@/lib/collections/resolve';

export interface CollectionCardData {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  cover_image: string | null;
  tags: string[];
  view_count: number;
  accent: string | null;
  item_count: number;
  /** Обратная совместимость с клиентами, суммирующими place+route. */
  place_count: number;
  route_count: number;
}

export async function loadPublicCollections(opts: { tag?: string | null; limit: number }): Promise<CollectionCardData[]> {
  const conditions = ['c.is_public = TRUE'];
  const params: unknown[] = [];

  if (opts.tag) {
    params.push(opts.tag);
    conditions.push(`$${params.length} = ANY(c.tags)`);
  }

  const { rows } = await pool.query<CollectionRow & { created_at: string }>(
    `SELECT
       c.id, c.slug, c.title, c.description, c.cover_image,
       c.tags, c.view_count, c.created_at, c.place_ids, c.route_ids,
       c.rule_kind, c.rule_location_type, c.rule_activity_type,
       c.rule_difficulty, c.rule_query, c.rule_limit, c.accent
     FROM collections c
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.view_count DESC, c.created_at DESC
     LIMIT $${params.length + 1}`,
    [...params, opts.limit]
  );

  const withCounts = await Promise.all(
    rows.map(async (c) => {
      const itemCount = await resolveCollectionCount(c);
      return {
        id: String(c.id), slug: c.slug, title: c.title, description: c.description ?? null,
        cover_image: c.cover_image ?? null, tags: c.tags ?? [], view_count: Number(c.view_count ?? 0),
        accent: c.accent ?? null, item_count: itemCount,
        place_count: c.rule_kind === 'route' ? 0 : itemCount,
        route_count: c.rule_kind === 'route' ? itemCount : 0,
      };
    })
  );

  return withCounts.filter((c) => c.item_count > 0);
}
