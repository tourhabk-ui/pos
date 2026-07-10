/**
 * lib/routes/audit.ts — диагностика качества данных в kamchatka_routes.
 *
 * Общий модуль для двух поверхностей:
 *   - GET /api/admin/routes/audit  (админ-сессия, для владельца в браузере);
 *   - GET /api/cron/routes-audit   (Bearer CRON_SECRET, для workflow → лог Actions,
 *                                   чтобы агент видел цифры прода без доступа к БД).
 *
 * Только читает. Категории — пробелы, из-за которых карточка маршрута неполна:
 *   no_geometry     — нет трека (geometry) → нечего показать на карте;
 *   no_waypoints    — маршрут не связан ни с одной точкой (route_waypoints);
 *   no_distance     — не задана дистанция;
 *   no_difficulty   — не задана сложность;
 *   short_description — описание короче 100 символов;
 *   no_activity_type — не задан тип активности.
 */

import { pool } from '@/lib/db-pool';

interface CategoryDef { key: string; label: string; where: string }

const CATEGORIES: CategoryDef[] = [
  { key: 'no_geometry', label: 'Нет трека (geometry)', where: `geometry IS NULL` },
  { key: 'no_waypoints', label: 'Нет точек маршрута (route_waypoints)', where: `NOT EXISTS (SELECT 1 FROM route_waypoints rw WHERE rw.route_id = kamchatka_routes.id)` },
  { key: 'no_distance', label: 'Нет дистанции', where: `distance_km IS NULL` },
  { key: 'no_difficulty', label: 'Нет сложности', where: `difficulty IS NULL OR difficulty = ''` },
  { key: 'short_description', label: 'Описание короче 100 символов', where: `description IS NULL OR LENGTH(description) < 100` },
  { key: 'no_activity_type', label: 'Нет типа активности', where: `activity_type IS NULL OR activity_type = ''` },
];

export interface RoutesAuditSample { id: string; title: string; is_visible: boolean }
export interface RoutesAuditCategory {
  key: string; label: string; count: number; visibleCount: number; samples: RoutesAuditSample[];
}
export interface RoutesAudit {
  total: number; visible: number; hidden: number; categories: RoutesAuditCategory[];
}

export async function computeRoutesAudit(sampleLimit = 20): Promise<RoutesAudit> {
  const totals = await pool.query<{ total: string; visible: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE is_visible = true) AS visible
     FROM kamchatka_routes`,
  );
  const total = parseInt(totals.rows[0]?.total ?? '0', 10);
  const visible = parseInt(totals.rows[0]?.visible ?? '0', 10);

  const categories: RoutesAuditCategory[] = [];
  for (const cat of CATEGORIES) {
    const counts = await pool.query<{ count: string; visible_count: string }>(
      `SELECT COUNT(*) AS count,
              COUNT(*) FILTER (WHERE is_visible = true) AS visible_count
       FROM kamchatka_routes
       WHERE (${cat.where})`,
    );
    const samples = await pool.query<RoutesAuditSample>(
      `SELECT id::text AS id, title, is_visible
       FROM kamchatka_routes
       WHERE (${cat.where})
       ORDER BY is_visible DESC, title ASC
       LIMIT ${sampleLimit}`,
    );
    categories.push({
      key: cat.key,
      label: cat.label,
      count: parseInt(counts.rows[0]?.count ?? '0', 10),
      visibleCount: parseInt(counts.rows[0]?.visible_count ?? '0', 10),
      samples: samples.rows,
    });
  }

  return { total, visible, hidden: total - visible, categories };
}
