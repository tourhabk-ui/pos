import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface ToolRow {
  id: string; slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; api_available: boolean;
  rating: string | null; use_count: number; click_count: number; created_at: string;
}

interface SimilarRow {
  slug: string; name: string; category: string;
  is_free: boolean; api_available: boolean; rating: string | null; use_count: number;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const result = await pool.query<ToolRow>(
      `SELECT id, slug, name, description, url, category, tags,
              is_free, api_available, rating, use_count, click_count, created_at
       FROM external_tools WHERE slug = $1 AND verified = TRUE`,
      [slug]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Инструмент не найден' }, { status: 404 });
    }

    const tool = result.rows[0];

    const similar = await pool.query<SimilarRow>(
      `SELECT slug, name, category, is_free, api_available, rating, use_count
       FROM external_tools
       WHERE category = $1 AND slug != $2 AND verified = TRUE
       ORDER BY use_count DESC LIMIT 4`,
      [tool.category, slug]
    );

    return NextResponse.json({ tool, similar: similar.rows });
  } catch (error) {
    return NextResponse.json({ error: 'Ошибка загрузки инструмента' }, { status: 500 });
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    await pool.query(
      `UPDATE external_tools SET click_count = click_count + 1 WHERE slug = $1 AND verified = TRUE`,
      [slug]
    );
  } catch {
    // fire-and-forget, don't fail the request
  }
  return NextResponse.json({ ok: true });
}
