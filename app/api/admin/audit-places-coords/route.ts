/**
 * GET /api/admin/audit-places-coords
 *
 * Точки `places`, чьи координаты падают в море или вне камчатской рамки.
 *
 * Повод: фильтр «Источники» на карте показал термальные источники посреди
 * Охотского моря (скрин владельца 14.08). Битая координата на карте выглядит
 * так же уверенно, как настоящая, и глазами на 779 точках не ловится.
 *
 * READ-ONLY: эндпоинт только называет подозреваемых, координаты не трогает.
 * Автопочинка запрещена сознательно — имена и места путаные (ср. подход
 * lib/routes/relief-sanity.ts), решает человек по списку.
 *
 * Градация по расстоянию до берега, потому что контур упрощён (~1 км):
 *   sea_far  (> 2 км от берега)  — почти наверняка битые координаты;
 *   sea_near (≤ 2 км)            — возможно, коса или бухта, съеденная
 *                                  упрощением (Усть-Камчатск стоит на такой);
 *   outside_region               — вне рамки Камчатки: перепутанные знаки,
 *                                  нули, чужой регион.
 *
 * Отдельная корзина water_feature: бухтам, лиманам и островам ПОЛОЖЕНО
 * читаться «морем» — бухта и есть вода, а остров Старичков слишком мал для
 * контура Natural Earth. Перепись 15.08 показала: без этой корзины треть
 * sea_far — «Авачинская бухта в море», то есть шум, заслоняющий настоящие
 * находки вроде Паланских источников в 105 км от берега.
 *
 * Auth: requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { landVerdict, distanceToCoastKm } from '@/lib/geo/land';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Дальше этого от берега «море» перестаёт быть спорным. */
const NEAR_COAST_KM = 2;

/** Типы, которым положено быть в воде или у самой кромки. */
const WATER_TYPES = new Set(['bay', 'island']);

interface PlaceRow {
  id: string;
  name: string;
  location_type: string | null;
  lat: string | number;
  lng: string | number;
}

interface Offender {
  id: string;
  name: string;
  locationType: string | null;
  lat: number;
  lng: number;
  coastKm: number | null;
}

export async function GET(request: NextRequest) {
  const adminOrRes = await requireAdmin(request);
  if (adminOrRes instanceof NextResponse) return adminOrRes;

  try {
    const { rows } = await pool.query<PlaceRow>(
      `SELECT id, name, location_type, lat, lng
       FROM places
       WHERE lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY name`,
    );

    const seaFar: Offender[] = [];
    const seaNear: Offender[] = [];
    const outside: Offender[] = [];
    const waterFeatures: Offender[] = [];

    for (const r of rows) {
      const lat = typeof r.lat === 'number' ? r.lat : parseFloat(r.lat);
      const lng = typeof r.lng === 'number' ? r.lng : parseFloat(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const verdict = landVerdict(lat, lng);
      if (verdict === 'land') continue;

      const base = { id: r.id, name: r.name, locationType: r.location_type, lat, lng };
      if (verdict === 'outside_region') {
        outside.push({ ...base, coastKm: null });
      } else {
        const coastKm = Math.round(distanceToCoastKm(lat, lng) * 10) / 10;
        if (WATER_TYPES.has(r.location_type ?? '')) {
          waterFeatures.push({ ...base, coastKm });
        } else {
          (coastKm > NEAR_COAST_KM ? seaFar : seaNear).push({ ...base, coastKm });
        }
      }
    }

    // Самые далёкие от берега — первыми: это самые уверенные находки.
    seaFar.sort((a, b) => (b.coastKm ?? 0) - (a.coastKm ?? 0));
    seaNear.sort((a, b) => (b.coastKm ?? 0) - (a.coastKm ?? 0));

    const byType = (list: Offender[]) => {
      const acc: Record<string, number> = {};
      for (const o of list) acc[o.locationType ?? 'null'] = (acc[o.locationType ?? 'null'] ?? 0) + 1;
      return acc;
    };

    return NextResponse.json({
      success: true,
      checked: rows.length,
      summary: {
        sea_far: seaFar.length,
        sea_near: seaNear.length,
        outside_region: outside.length,
        water_feature: waterFeatures.length,
        sea_far_by_type: byType(seaFar),
      },
      near_coast_km: NEAR_COAST_KM,
      note:
        'sea_far — почти наверняка битые координаты; sea_near — возможно, коса или бухта, ' +
        'съеденная упрощением контура (~1 км); outside_region — вне рамки Камчатки; ' +
        'water_feature — бухты и острова, им положено быть в воде. ' +
        'Эндпоинт ничего не чинит: решение по каждой точке — за человеком.',
      sea_far: seaFar,
      sea_near: seaNear,
      outside_region: outside,
      water_feature: waterFeatures,
    });
  } catch (err) {
    console.error('[audit-places-coords]', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Ошибка аудита координат' },
      { status: 500 },
    );
  }
}
