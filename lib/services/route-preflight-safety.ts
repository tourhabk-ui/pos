/**
 * lib/services/route-preflight-safety.ts
 *
 * Pre-flight safety-чек маршрута для гида (issue #248): перед выходом группы
 * гид получает структурированный чеклист доступных safety-данных маршрута —
 * отсутствие поля явно помечается "нет данных", а не тихо пропускается
 * (турист/гид должен видеть пробел, а не считать его отсутствием риска).
 *
 * Резолвит маршрут ПО НАЗВАНИЮ (ILIKE), не по id — реалистичный ввод гида
 * в чате это название, а не UUID. `water_points`, упомянутый в исходном
 * issue, не существует в схеме v_kamchatka_routes_api — использованы
 * реальные safety-поля: hazards, equipment, mchs_registration_required.
 */

import { pool } from '@/lib/db-pool';
import { hasValidTrack } from './offline-readiness';

export interface RoutePreflightSafety {
  routeId: string;
  title: string;
  hasGeometry: boolean;
  hasMchsContact: boolean;
  mchsRegistrationRequired: boolean | null;
  difficulty: string | null;
  hazards: string[];
  equipment: string[];
}

interface PreflightRow {
  id: string;
  title: string;
  geometry: { coordinates?: unknown } | null;
  mchs_phone: string | null;
  mchs_registration_required: boolean | null;
  difficulty: string | null;
  hazards: string[] | null;
  equipment: string[] | null;
}

export async function findRoutePreflightSafety(titleQuery: string): Promise<RoutePreflightSafety | null> {
  const { rows } = await pool.query<PreflightRow>(
    `SELECT id, title, geometry, mchs_phone, mchs_registration_required, difficulty, hazards, equipment
     FROM v_kamchatka_routes_api
     WHERE title ILIKE $1
     ORDER BY view_count DESC NULLS LAST
     LIMIT 1`,
    [`%${titleQuery}%`],
  );
  const r = rows[0];
  if (!r) return null;

  return {
    routeId: r.id,
    title: r.title,
    hasGeometry: hasValidTrack(r.geometry),
    hasMchsContact: !!r.mchs_phone && r.mchs_phone.trim().length > 0,
    mchsRegistrationRequired: r.mchs_registration_required,
    difficulty: r.difficulty,
    hazards: Array.isArray(r.hazards) ? r.hazards : [],
    equipment: Array.isArray(r.equipment) ? r.equipment : [],
  };
}
