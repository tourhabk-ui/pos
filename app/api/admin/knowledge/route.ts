import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAdmin } from '@/lib/auth/middleware';
import type { KnowledgeRouteRow, TotalRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/knowledge
 * Перечень мест и маршрутов, которыми располагает Кузьмич: название,
 * категория, источник, есть ли координаты и вектор для поиска.
 *
 * 03.09: читает master-таблицы `places` и `kamchatka_routes` напрямую.
 * Раньше — через VIEW `agent_route_knowledge`, запрещённый для нового кода
 * (CLAUDE.md §4.1): за одним именем «маршрут» стояли две сущности разной
 * природы, и таблица показывала их неразличимо. Теперь у строки есть `kind`.
 */
const KB_CTE = `
  WITH kb AS (
    SELECT p.ark_id::text AS id, 'place'::text AS kind, p.name AS title, p.category,
           p.description, p.source_url, p.source_name, p.lat, p.lng,
           '{}'::jsonb AS payload, (p.embedding IS NOT NULL) AS has_embedding,
           p.created_at, p.updated_at
      FROM places p
     WHERE p.merged_into_id IS NULL
    UNION ALL
    SELECT r.id::text AS id, 'route'::text AS kind, r.title, r.category,
           r.description, r.source_url, r.source_name, r.lat, r.lng,
           COALESCE(r.metadata, '{}'::jsonb) AS payload, (r.embedding IS NOT NULL) AS has_embedding,
           r.created_at, r.updated_at
      FROM kamchatka_routes r
     WHERE r.merged_into_id IS NULL
  )`;

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const search = searchParams.get('search');
    const kind = searchParams.get('kind');
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '30', 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(category);
    }
    if (kind === 'place' || kind === 'route') {
      conditions.push(`kind = $${paramIdx++}`);
      params.push(kind);
    }
    if (search) {
      conditions.push(`to_tsvector('russian', title) @@ plainto_tsquery('russian', $${paramIdx++})`);
      params.push(search);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<TotalRow>(
      `${KB_CTE} SELECT COUNT(*) as total FROM kb ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    const dataParams = [...params, limit, offset];
    const limitParam = paramIdx++;
    const offsetParam = paramIdx;

    const result = await query<KnowledgeRouteRow>(
      `${KB_CTE}
       SELECT id, kind, title, category, description, source_url, source_name,
              lat, lng,
              payload->>'difficulty' as difficulty,
              payload->>'duration' as duration,
              payload->>'season' as season,
              payload->>'price_from' as price_from,
              has_embedding,
              created_at, updated_at
         FROM kb
         ${whereClause}
        ORDER BY title ASC
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      dataParams
    );

    return NextResponse.json({
      success: true,
      data: {
        routes: result.rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('[admin/knowledge] перечень не прочитан', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки базы знаний' },
      { status: 500 }
    );
  }
}
