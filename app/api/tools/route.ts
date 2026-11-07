/**
 * GET /api/tools — сторонние приложения в дорогу (external_tools, миграция 1396).
 *
 * Порядок один и назван: по разделу, внутри — по имени. Прежняя сортировка
 * «trending» шла по use_count — по числу попаданий в ответ Кузьмича, то есть
 * сама себя подкармливала, а «по рейтингу» — по оценкам, которых не было
 * (1341). Параметр sort принимается и не меняет порядка: старые ссылки живы.
 * Рейтинга и счётчика попаданий в ответе нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface ToolRow {
  id: string; slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; click_count: number;
}

interface CategoryRow { category: string; cnt: string; }

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  const limit = Math.min(Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100, 200);

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

  try {
    const [toolsRes, catsRes] = await Promise.all([
      pool.query<ToolRow>(
        `SELECT id, slug, name, description, url, category, tags, is_free, click_count
         FROM external_tools
         WHERE ${conditions.join(' AND ')}
         ORDER BY category, name
         LIMIT $${idx}`,
        [...params, limit],
      ),
      pool.query<CategoryRow>(
        `SELECT category, count(*)::text AS cnt
         FROM external_tools WHERE verified = TRUE
         GROUP BY category ORDER BY count(*) DESC`,
      ),
    ]);

    return NextResponse.json({
      tools: toolsRes.rows,
      categories: catsRes.rows.map(r => ({ category: r.category, count: parseInt(r.cnt, 10) })),
      order: 'по разделу, внутри — по имени',
    });
  } catch (error) {
    // ORDER BY по псевдониму агрегата падал на каждом вызове, а молчащий
    // catch выдавал это за отказ каталога (#1773). Имя и SQLSTATE — в лог.
    console.error(
      '[tools] запрос не выполнен:',
      (error as { code?: string })?.code ?? '',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: 'Список приложений не загрузился' },
      { status: 500 }
    );
  }
}
