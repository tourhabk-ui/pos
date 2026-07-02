/**
 * lib/services/rescue-coverage.ts
 *
 * Health-метрика покрытия маршрутов контактами МЧС (issue #247) — прямой
 * вклад в метрику безопасности: маршрут без телефона для регистрации/
 * консультации с МЧС не даёт туристу способа связаться со спасателями
 * заранее.
 *
 * ПРИМЕЧАНИЕ: в исходном issue фигурирует колонка `rescue_contacts` —
 * такой колонки в v_kamchatka_routes_api/kamchatka_routes нет (проверено
 * по миграции 670 и CLAUDE.md §10). Реальная колонка с этим смыслом —
 * `mchs_phone` (телефон МЧС для регистрации/консультации). Используется она.
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
    `SELECT id, mchs_phone FROM v_kamchatka_routes_api`,
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
