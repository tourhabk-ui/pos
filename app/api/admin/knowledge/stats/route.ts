import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAdmin } from '@/lib/auth/middleware';
import type {
  KnowledgeCategoryStatsRow,
  KnowledgeSourceStatsRow,
  KnowledgeTotalsRow,
} from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/knowledge/stats
 * Сколько мест и маршрутов знает Кузьмич и у скольких есть вектор поиска.
 *
 * 03.09: читает master-таблицы `places` и `kamchatka_routes`, а не VIEW
 * `agent_route_knowledge` (CLAUDE.md §4.1). И считает троично (§4.0): раньше
 * каждый отказ запроса глох в пустом catch и отдавался нулём — «маршрутов: 0»
 * при упавшей базе выглядело ровно как пустая база. Теперь отказ — это
 * `null` с причиной в ответе и строка в логе.
 */
interface Failed { reason: string }

async function safely<T>(name: string, fn: () => Promise<T>): Promise<T | Failed> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[admin/knowledge/stats] ${name} не посчитан`, err);
    return { reason: `${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isFailed(v: unknown): v is Failed {
  return typeof v === 'object' && v !== null && 'reason' in v;
}

const KB_CTE = `
  WITH kb AS (
    SELECT 'place'::text AS kind, p.category, p.source_name, p.embedding
      FROM places p WHERE p.merged_into_id IS NULL
    UNION ALL
    SELECT 'route'::text AS kind, r.category, r.source_name, r.embedding
      FROM kamchatka_routes r WHERE r.merged_into_id IS NULL
  )`;

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const [totals, categories, sources] = await Promise.all([
      safely('итоги', async () => {
        const r = await query<KnowledgeTotalsRow>(
          `${KB_CTE}
           SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS embedded,
                  COUNT(*) FILTER (WHERE kind = 'place')::text AS places,
                  COUNT(*) FILTER (WHERE kind = 'route')::text AS routes
             FROM kb`,
          []
        );
        const row = r.rows[0];
        return {
          total: parseInt(row?.total ?? '0', 10),
          embedded: parseInt(row?.embedded ?? '0', 10),
          places: parseInt(row?.places ?? '0', 10),
          routes: parseInt(row?.routes ?? '0', 10),
        };
      }),
      safely('категории', async () => {
        const r = await query<KnowledgeCategoryStatsRow>(
          `${KB_CTE}
           SELECT category, COUNT(*)::text AS count FROM kb
            GROUP BY category ORDER BY COUNT(*) DESC`,
          []
        );
        return r.rows.map(row => ({ category: row.category ?? 'без категории', count: parseInt(row.count, 10) }));
      }),
      safely('источники', async () => {
        const r = await query<KnowledgeSourceStatsRow>(
          `${KB_CTE}
           SELECT source_name, COUNT(*)::text AS count FROM kb
            GROUP BY source_name ORDER BY COUNT(*) DESC`,
          []
        );
        return r.rows.map(row => ({ source: row.source_name ?? 'источник не записан', count: parseInt(row.count, 10) }));
      }),
    ]);

    const failures = [totals, categories, sources].filter(isFailed).map(f => f.reason);

    return NextResponse.json({
      success: true,
      data: {
        totals: isFailed(totals) ? null : totals,
        categories: isFailed(categories) ? null : categories,
        sources: isFailed(sources) ? null : sources,
        failures,
      },
    });
  } catch (error) {
    console.error('[admin/knowledge/stats] статистика не прочитана', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки статистики' },
      { status: 500 }
    );
  }
}
