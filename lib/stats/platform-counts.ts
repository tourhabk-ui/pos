/**
 * lib/stats/platform-counts.ts
 *
 * ЕДИНЫЙ источник счётчиков платформы для главной. До этого одну сущность
 * считали 4 независимых блока с разными фильтрами → на витрине жили 4 разных
 * числа (610/473/154/118). Теперь все читают отсюда.
 *
 * Истина = то, что турист видит при клике на /routes. Каталог (`queryCatalog`)
 * читает VIEW `agent_route_knowledge`, а тот — чистый UNION ALL мастер-таблиц
 * (migration 677): kind='place' == строки `places`, kind='route' == строки
 * `kamchatka_routes`, с passthrough `is_visible`/`location_type`. Поэтому счёт
 * из мастер-таблиц ТОЧНО равен числу листинга — и §4.1 соблюдён (без нового
 * `FROM agent_route_knowledge`), и Σ по типам == тоталу мест by construction.
 */

import { unstable_cache } from 'next/cache';
import { query } from '@/lib/database';

export interface PlatformCounts {
  /** видимые маршруты — как /routes?kind=route */
  routes: number;
  /** видимые точки — как /routes?kind=place */
  places: number;
  /** видимые маршруты с обязательной регистрацией МЧС */
  mchsRoutes: number;
  /** точки с профилем безопасности */
  safetyProfiles: number;
  /** видимые точки по location_type (для «Стихий»); Σ + (места без типа) == places */
  placesByType: Record<string, number>;
}

async function loadPlatformCounts(): Promise<PlatformCounts> {
  const [routes, places, mchs, profiles, byType] = await Promise.all([
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM kamchatka_routes WHERE is_visible = TRUE`),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM places WHERE is_visible = TRUE`),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM kamchatka_routes
        WHERE is_visible = TRUE AND mchs_registration_required = TRUE`,
    ),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM location_safety_profile`),
    query<{ location_type: string | null; n: string }>(
      `SELECT location_type, COUNT(*)::text AS n
         FROM places
        WHERE is_visible = TRUE AND location_type IS NOT NULL
        GROUP BY location_type`,
    ),
  ]);

  const placesByType: Record<string, number> = {};
  for (const r of byType.rows) placesByType[(r.location_type || '').toLowerCase()] = parseInt(r.n, 10);

  return {
    routes: parseInt(routes.rows[0]?.n ?? '0', 10),
    places: parseInt(places.rows[0]?.n ?? '0', 10),
    mchsRoutes: parseInt(mchs.rows[0]?.n ?? '0', 10),
    safetyProfiles: parseInt(profiles.rows[0]?.n ?? '0', 10),
    placesByType,
  };
}

/** Кэш 1 час: цифры меняются импортами, не по минутам. */
export const getPlatformCounts = unstable_cache(
  loadPlatformCounts,
  ['platform-counts-v1'],
  { revalidate: 3600 },
);
