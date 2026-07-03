/**
 * lib/services/query-expansion-health.ts
 *
 * Агрегирует query_expansion_log (issue #250) за последние 7 дней: средний
 * прирост вариантов и доля запросов, где multi-query добавил хотя бы один
 * маршрут, которого не было в выдаче по базовому запросу. Используется
 * для решения — оставлять RAG_MULTIQUERY включённым или откатывать.
 */

import { pool } from '@/lib/db-pool';

export interface QueryExpansionHealth {
  totalLogged: number;
  avgExpanded: number;
  pctWithNewResults: number;
}

export async function computeQueryExpansionHealth(): Promise<QueryExpansionHealth> {
  const { rows } = await pool.query<{
    total: string; avg_expanded: string | null; with_new_results: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       AVG(expanded_count) AS avg_expanded,
       COUNT(*) FILTER (WHERE unique_added > 0) AS with_new_results
     FROM query_expansion_log
     WHERE created_at > NOW() - INTERVAL '7 days'`,
  );

  const row = rows[0];
  const total = parseInt(row?.total ?? '0', 10);
  const avgExpanded = row?.avg_expanded != null ? Math.round(Number(row.avg_expanded) * 10) / 10 : 0;
  const withNewResults = parseInt(row?.with_new_results ?? '0', 10);
  const pctWithNewResults = total > 0 ? Math.round((withNewResults / total) * 1000) / 10 : 0;

  return {
    totalLogged: total,
    avgExpanded,
    pctWithNewResults,
  };
}
