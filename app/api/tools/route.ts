import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface ToolRow {
  id: string; slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; api_available: boolean;
  rating: string | null; use_count: number; click_count: number; created_at: string;
}

interface CategoryRow { category: string; cnt: string; }

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  const sort = searchParams.get('sort') ?? 'trending';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 200);

  const conditions: string[] = ['verified = TRUE'];
  const params: unknown[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(search_vector @@ plainto_tsquery('simple', $${idx}) OR name ILIKE $${idx + 1} OR description ILIKE $${idx + 2})`);
    params.push(q.toLowerCase(), `%${q}%`, `%${q}%`);
    idx += 3;
  }

  if (category && category !== 'all') {
    conditions.push(`category = $${idx}`);
    params.push(category);
    idx++;
  }

  const orderBy = sort === 'rating'
    ? 'rating DESC NULLS LAST, use_count DESC'
    : sort === 'new'
    ? 'created_at DESC'
    : 'use_count DESC, rating DESC NULLS LAST';

  try {
    const [toolsRes, catsRes] = await Promise.all([
      pool.query<ToolRow>(
        `SELECT id, slug, name, description, url, category, tags,
                is_free, api_available, rating, use_count, click_count, created_at
         FROM external_tools
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT $${idx}`,
        [...params, limit],
      ),
      pool.query<CategoryRow>(
        `SELECT category, count(*)::text AS cnt
         FROM external_tools WHERE verified = TRUE
         GROUP BY category ORDER BY cnt::int DESC`,
      ),
    ]);

    return NextResponse.json({
      tools: toolsRes.rows,
      categories: catsRes.rows.map(r => ({ category: r.category, count: parseInt(r.cnt, 10) })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Ошибка загрузки инструментов' },
      { status: 500 }
    );
  }
}
