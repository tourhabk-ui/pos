import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { resolveCollectionCount, type CollectionRow } from '@/lib/collections/resolve';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get('tag');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50);

  const conditions = ['c.is_public = TRUE'];
  const params: unknown[] = [];

  if (tag) {
    params.push(tag);
    conditions.push(`$${params.length} = ANY(c.tags)`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query<CollectionRow & { created_at: string }>(
    `SELECT
       c.id, c.slug, c.title, c.description, c.cover_image,
       c.tags, c.view_count, c.created_at, c.place_ids, c.route_ids,
       c.rule_kind, c.rule_location_type, c.rule_activity_type,
       c.rule_difficulty, c.rule_query, c.rule_limit, c.accent
     FROM collections c
     ${where}
     ORDER BY c.view_count DESC, c.created_at DESC
     LIMIT $${params.length + 1}`,
    [...params, limit]
  );

  // Честный размер каждой подборки: правило → COUNT каталога, иначе — массивы.
  // Пустой счётчик на «Вулканах Камчатки» больше не появится.
  const withCounts = await Promise.all(
    rows.map(async (c) => {
      const itemCount = await resolveCollectionCount(c);
      return {
        id: c.id, slug: c.slug, title: c.title, description: c.description,
        cover_image: c.cover_image, tags: c.tags, view_count: c.view_count,
        accent: c.accent, item_count: itemCount,
        // Обратная совместимость с клиентом, суммирующим place+route
        place_count: c.rule_kind === 'route' ? 0 : itemCount,
        route_count: c.rule_kind === 'route' ? itemCount : 0,
      };
    })
  );

  // Не показываем ПУСТУЮ подборку: лучше её нет, чем «Вулканы Камчатки → 0».
  // Появятся данные под правило — появится и карточка.
  const collections = withCounts.filter((c) => c.item_count > 0);

  return NextResponse.json({ collections });
}
