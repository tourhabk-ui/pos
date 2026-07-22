import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { resolveCollectionContent, type CollectionRow } from '@/lib/collections/resolve';

export const dynamic = 'force-dynamic';

interface RouteParams { params: Promise<{ slug: string }> }

export async function GET(_req: Request, { params }: RouteParams) {
  const { slug } = await params;

  if (!/^[a-z0-9-]{1,120}$/.test(slug)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const { rows: [col] } = await pool.query<CollectionRow>(
    `SELECT id, slug, title, description, cover_image, place_ids, route_ids, tags, view_count,
            rule_kind, rule_location_type, rule_activity_type, rule_difficulty, rule_query, rule_limit, accent
     FROM collections WHERE slug = $1 AND is_public = TRUE`,
    [slug]
  );

  if (!col) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Increment view count (fire-and-forget)
  pool.query('UPDATE collections SET view_count = view_count + 1 WHERE slug = $1', [slug]).catch(() => {});

  // Члены подборки — из правила (queryCatalog, тот же источник что /routes) или
  // из ручных массивов id. Пустых «Вулканов Камчатки» больше нет.
  const { places, routes } = await resolveCollectionContent(col);

  return NextResponse.json({ collection: { ...col, places, routes } });
}
