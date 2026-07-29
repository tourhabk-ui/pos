/**
 * lib/services/rescue-coverage.ts
 *
 * Health-метрика покрытия маршрутов контактами МЧС (issue #247) — прямой
 * вклад в метрику безопасности: маршрут без телефона для регистрации/
 * консультации с МЧС не даёт туристу способа связаться со спасателями
 * заранее.
 *
 * ПРИМЕЧАНИЕ: в исходном issue фигурирует колонка `rescue_contacts` —
 * такой колонки нет. Реальная колонка с этим смыслом — `mchs_phone` (телефон
 * МЧС для регистрации/консультации). Используется она.
 *
 * Правка 28.07: запрос шёл в `v_kamchatka_routes_api` и падал на проде при
 * каждом вызове. Аудит боевой схемы показал набор колонок живого
 * представления: route_id, route_dedupe_key, category, title, description,
 * lat, lng, source_url, source_name, import_source, has_coordinates,
 * category_total, category_position, metadata, created_at, source_updated_at.
 * Ни `id`, ни `mchs_phone` там НЕТ — представление на проде осталось от старой
 * версии, а миграции 670 и 738, которые привели бы его к виду из файлов, не
 * применялись ни разу (670 — «cannot change name of view column route_id to
 * id», 738 — «other objects depend on it»). То есть метрика покрытия МЧС
 * молчала не потому, что покрытие плохое, а потому что запрос не выполнялся.
 *
 * Пока представление не починено, читаем мастер-таблицу напрямую с явным
 * фильтром видимости — тем самым, который и должен стоять во вьюхе. Правило
 * CLAUDE.md про `v_kamchatka_routes_api` существует ради того, чтобы наружу не
 * попадали скрытые маршруты; фильтр это обеспечивает.
 */

import { pool } from '@/lib/db-pool';

export interface RescueCoverage {
  totalRoutes: number;
  withRescueContacts: number;
  coveragePercent: number;
  routesMissing: string[];
}

export async function computeRescueCoverage(): Promise<RescueCoverage> {
  const { rows } = await pool.query<{ id: string; mchs_phone: string | null }>(
    `SELECT id, mchs_phone FROM kamchatka_routes
      WHERE is_visible = TRUE OR is_visible IS NULL`,
  );

  const totalRoutes = rows.length;
  const withContacts = rows.filter(r => !!r.mchs_phone && r.mchs_phone.trim().length > 0);
  const routesMissing = rows
    .filter(r => !r.mchs_phone || !r.mchs_phone.trim())
    .map(r => r.id);
  const coveragePercent = totalRoutes > 0
    ? Math.round((withContacts.length / totalRoutes) * 1000) / 10
    : 0;

  return {
    totalRoutes,
    withRescueContacts: withContacts.length,
    coveragePercent,
    routesMissing,
  };
}
