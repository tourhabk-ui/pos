/**
 * GET /api/admin/places/duplicates
 *
 * Находит кандидатов на дубли в places: пары мест, близкие по координатам
 * (≤300 м) и/или по похожести названия (триграммное сходство ≥0.5, напр.
 * "Авачинская сопка" / "Авачинский вулкан"). Ничего не меняет — только
 * находит и возвращает для ручного подтверждения через POST /merge.
 *
 * Уже слитые (merged_into_id IS NOT NULL) исключены из обеих сторон пары.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface DuplicateRow {
  id1: string; name1: string; lat1: number; lng1: number; type1: string | null; ark1: string | null;
  id2: string; name2: string; lat2: number; lng2: number; type2: string | null; ark2: string | null;
  has_photo1: boolean; has_photo2: boolean;
  has_safety1: boolean; has_safety2: boolean;
  dist_m: number; name_sim: number;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '100', 10) || 100, 300);

  const result = await pool.query<DuplicateRow>(
    `WITH pairs AS (
       SELECT
         p1.id AS id1, p1.name AS name1, p1.lat AS lat1, p1.lng AS lng1, p1.location_type AS type1, p1.ark_id AS ark1,
         p2.id AS id2, p2.name AS name2, p2.lat AS lat2, p2.lng AS lng2, p2.location_type AS type2, p2.ark_id AS ark2,
         similarity(p1.name, p2.name) AS name_sim,
         6371000 * acos(LEAST(1, GREATEST(-1,
           cos(radians(p1.lat)) * cos(radians(p2.lat)) * cos(radians(p2.lng) - radians(p1.lng)) +
           sin(radians(p1.lat)) * sin(radians(p2.lat))
         ))) AS dist_m
       FROM places p1
       JOIN places p2
         ON p2.id > p1.id
        AND p2.lat BETWEEN p1.lat - 0.01 AND p1.lat + 0.01
        AND p2.lng BETWEEN p1.lng - 0.02 AND p1.lng + 0.02
       WHERE p1.merged_into_id IS NULL AND p2.merged_into_id IS NULL
         AND p1.lat IS NOT NULL AND p1.lng IS NOT NULL
         AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
     )
     SELECT
       pairs.*,
       (ari1.route_id IS NOT NULL) AS has_photo1,
       (ari2.route_id IS NOT NULL) AS has_photo2,
       (lsp1.agent_route_id IS NOT NULL) AS has_safety1,
       (lsp2.agent_route_id IS NOT NULL) AS has_safety2
     FROM pairs
     LEFT JOIN ai_route_images ari1 ON ari1.route_id = pairs.ark1
     LEFT JOIN ai_route_images ari2 ON ari2.route_id = pairs.ark2
     LEFT JOIN location_safety_profile lsp1 ON lsp1.agent_route_id = pairs.ark1
     LEFT JOIN location_safety_profile lsp2 ON lsp2.agent_route_id = pairs.ark2
     WHERE pairs.dist_m <= 300 OR pairs.name_sim >= 0.5
     ORDER BY pairs.dist_m ASC NULLS LAST
     LIMIT $1`,
    [limit],
  );

  return NextResponse.json({
    pairs: result.rows.map((r) => ({
      distanceM: Math.round(r.dist_m),
      nameSimilarity: Math.round(r.name_sim * 100) / 100,
      places: [
        { id: r.id1, name: r.name1, lat: r.lat1, lng: r.lng1, locationType: r.type1, arkId: r.ark1, hasPhoto: r.has_photo1, hasSafetyProfile: r.has_safety1 },
        { id: r.id2, name: r.name2, lat: r.lat2, lng: r.lng2, locationType: r.type2, arkId: r.ark2, hasPhoto: r.has_photo2, hasSafetyProfile: r.has_safety2 },
      ],
    })),
  });
}
