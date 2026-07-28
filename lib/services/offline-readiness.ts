/**
 * lib/services/offline-readiness.ts
 *
 * Офлайн-проверка целостности SOS-пакета маршрута перед выходом на тропу
 * (issue #246): турист до выхода видит, какие данные маршрута реально
 * доступны офлайн (трек, контакт МЧС, описание), а какие отсутствуют —
 * снижает риск ухода на маршрут без данных, нужных для SOS.
 *
 * Колонка `rescue_contacts` из исходного issue не существует в схеме
 * (см. lib/services/rescue-coverage.ts) — используется реальная mchs_phone.
 */

import { query } from '@/lib/database';

export interface OfflineReadiness {
  routeId: string;
  hasGeometry: boolean;
  hasRescueContacts: boolean;
  hasDescription: boolean;
  readinessPercent: number;
}

interface RouteReadinessRow {
  geometry: { coordinates?: unknown } | null;
  mchs_phone: string | null;
  description: string | null;
}

export function hasValidTrack(geometry: RouteReadinessRow['geometry']): boolean {
  if (!geometry || typeof geometry !== 'object') return false;
  const coords = geometry.coordinates;
  return Array.isArray(coords) && coords.length > 1;
}

export async function checkRouteOfflineReadiness(routeId: string): Promise<OfflineReadiness | null> {
  const { rows } = await query<RouteReadinessRow>(
    // Живое представление v_kamchatka_routes_api не содержит ни geometry, ни
    // mchs_phone, ни даже id — аудит боевой схемы 28.07. Запрос падал при
    // каждом обращении, то есть готовность офлайн-пакета не проверялась
    // вообще. Читаем мастер-таблицу с тем же фильтром видимости, который
    // должен стоять во вьюхе; подробности — в lib/services/safety/
    // rescue-coverage.ts.
    `SELECT geometry, mchs_phone, description FROM kamchatka_routes
      WHERE id = $1 AND (is_visible = TRUE OR is_visible IS NULL)`,
    [routeId],
  );
  const r = rows[0];
  if (!r) return null;

  const hasGeometry = hasValidTrack(r.geometry);
  const hasRescueContacts = !!r.mchs_phone && r.mchs_phone.trim().length > 0;
  const hasDescription = !!r.description && r.description.trim().length > 0;

  const checks = [hasGeometry, hasRescueContacts, hasDescription];
  const readinessPercent = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  return { routeId, hasGeometry, hasRescueContacts, hasDescription, readinessPercent };
}
