/**
 * lib/places/audit.ts — диагностика качества данных в places.
 *
 * Общий модуль для двух поверхностей:
 *   - GET /api/admin/places/audit    (админ-сессия, для владельца в браузере);
 *   - GET /api/cron/places-audit     (Bearer CRON_SECRET, для workflow → лог Actions,
 *                                     чтобы агент видел цифры прода без доступа к БД).
 *
 * Только читает. Категории проблем описаны в CATEGORIES.
 */

import { pool } from '@/lib/db-pool';

// Имена-НЕместа: активности/туры/SEO-заголовки, не географические точки.
const NON_PLACE_RE =
  `(^\\s*(восхождение|поход|сплав|путешествие|трекинг|скитур|джип-тур|вертолётн|экскурсия|тур\\s))` +
  `|(:\\s*(путь на вершину|где находится|как добраться|маршрут))` +
  `|(\\s(где находится|как добраться)($|[:,]))` +
  `|(\\sв\\s20[0-9][0-9]($|[^0-9]))`;

// Плейсхолдер «нет GPS»: 0,0 или центр Петропавловска (migration 660).
const PLACEHOLDER_COND =
  `((lat = 0 AND lng = 0) OR (ROUND(lat::numeric, 4) = 53.0444 AND ROUND(lng::numeric, 4) = 158.6483))`;

const REAL_COORDS_COND =
  `lat IS NOT NULL AND lng IS NOT NULL AND NOT (lat = 0 AND lng = 0)` +
  ` AND NOT (ROUND(lat::numeric, 4) = 53.0444 AND ROUND(lng::numeric, 4) = 158.6483)`;

interface CategoryDef { key: string; label: string; where: string }

const CATEGORIES: CategoryDef[] = [
  { key: 'non_place_names', label: 'Имена-НЕместа (активности/туры/SEO)', where: `name ~* '${NON_PLACE_RE}'` },
  { key: 'out_of_bounds', label: 'Координаты вне Камчатки', where: `${REAL_COORDS_COND} AND (lat < 50.0 OR lat > 62.0 OR lng < 155.0 OR lng > 175.0)` },
  { key: 'placeholder_coords', label: 'Плейсхолдер-координаты (нет GPS)', where: PLACEHOLDER_COND },
  { key: 'no_coords', label: 'Без координат', where: `lat IS NULL OR lng IS NULL` },
  { key: 'mistyped_type', label: 'Пустой/неизвестный тип', where: `location_type IS NULL OR location_type = ''` },
];

export interface PlacesAuditSample { id: string; name: string; is_visible: boolean }
export interface PlacesAuditCategory {
  key: string; label: string; count: number; visibleCount: number; samples: PlacesAuditSample[];
}
export interface PlacesAudit {
  total: number; visible: number; hidden: number; categories: PlacesAuditCategory[];
}

export async function computePlacesAudit(sampleLimit = 20): Promise<PlacesAudit> {
  const totals = await pool.query<{ total: string; visible: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE is_visible = true) AS visible
     FROM places WHERE merged_into_id IS NULL`,
  );
  const total = parseInt(totals.rows[0]?.total ?? '0', 10);
  const visible = parseInt(totals.rows[0]?.visible ?? '0', 10);

  const categories: PlacesAuditCategory[] = [];
  for (const cat of CATEGORIES) {
    const counts = await pool.query<{ count: string; visible_count: string }>(
      `SELECT COUNT(*) AS count,
              COUNT(*) FILTER (WHERE is_visible = true) AS visible_count
       FROM places
       WHERE merged_into_id IS NULL AND (${cat.where})`,
    );
    const samples = await pool.query<PlacesAuditSample>(
      `SELECT id::text AS id, name, is_visible
       FROM places
       WHERE merged_into_id IS NULL AND (${cat.where})
       ORDER BY is_visible DESC, name ASC
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
