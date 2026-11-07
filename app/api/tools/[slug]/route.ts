/**
 * /api/tools/[slug] — одно стороннее приложение (GET) и щелчок человека по
 * ссылке на него (POST, click_count). Страниц отдельных приложений больше нет
 * (07.11): /ai-tools/<slug> переадресует на список, а GET остаётся для тех,
 * кто читает каталог как данные. Рейтинга и счётчика попаданий в ответ
 * Кузьмича здесь нет: первого не было (1341), второе не было ни советом, ни
 * использованием.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const dynamic = 'force-dynamic';

interface ToolRow {
  id: string; slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; click_count: number;
}

interface SimilarRow { slug: string; name: string; category: string; is_free: boolean; }

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const result = await pool.query<ToolRow>(
      `SELECT id, slug, name, description, url, category, tags, is_free, click_count
       FROM external_tools WHERE slug = $1 AND verified = TRUE`,
      [slug]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Приложение не найдено' }, { status: 404 });
    }

    const tool = result.rows[0];

    const similar = await pool.query<SimilarRow>(
      `SELECT slug, name, category, is_free
       FROM external_tools
       WHERE category = $1 AND slug != $2 AND verified = TRUE
       ORDER BY name LIMIT 4`,
      [tool.category, slug]
    );

    return NextResponse.json({ tool, similar: similar.rows });
  } catch (error) {
    logSwallowedFailure('tools', 'чтение приложения', error);
    return NextResponse.json({ error: 'Приложение не загрузилось' }, { status: 500 });
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
  } catch (error) {
    // Счётчик щелчков человеку не мешает: ответ прежний, отказ — в лог.
    logSwallowedFailure('tools', 'счётчик щелчков', error);
  }
  return NextResponse.json({ ok: true });
}
