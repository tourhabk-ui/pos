/**
 * GET /api/admin/places/duplicates
 *
 * Находит кандидатов на дубли в places: пары мест, близкие по координатам
 * (≤300 м) и/или по похожести названия (триграммное сходство ≥0.5, напр.
 * "Авачинская сопка" / "Авачинский вулкан"). Ничего не меняет — только
 * находит и возвращает для ручного подтверждения через POST /merge.
 *
 * Уже слитые (merged_into_id IS NOT NULL) исключены из обеих сторон пары.
 *
 * ВАЖНО про пустые координаты: у части мусорных мест GPS не заданы и хранятся
 * как 0,0 ЛИБО как плейсхолдер 53.0444/158.6483 (центр Петропавловска, куда
 * сажали места без известных координат — migration 660). Раньше расстояние
 * между любыми двумя такими считалось 0 м, и правило «≤300 м» пейрило вообще
 * не связанные места («Плато Антарктида» и «Маяк»). Поэтому:
 *   - дистанция считается ТОЛЬКО для пар с реальными (не 0,0) координатами;
 *   - «близкая» пара дополнительно требует хоть какого-то совпадения имени
 *     (name_sim ≥ 0.2) — чтобы соседство по координатам не флагало разные
 *     объекты в одной точке;
 *   - ветка по имени (name_sim ≥ 0.5) работает независимо от координат.
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
         -- Расстояние только для пар с реальными координатами; иначе NULL.
         -- «Реальные» = не NULL, не 0,0 и не плейсхолдер 53.0444/158.6483 (центр
         -- Петропавловска, куда сажали места без известного GPS — migration 660).
         -- Иначе десятки несвязанных мест в одной точке считались бы «0 м».
         CASE
           WHEN p1.lat IS NOT NULL AND p1.lng IS NOT NULL
            AND NOT (p1.lat = 0 AND p1.lng = 0)
            AND NOT (ROUND(p1.lat::numeric, 4) = 53.0444 AND ROUND(p1.lng::numeric, 4) = 158.6483)
            AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
            AND NOT (p2.lat = 0 AND p2.lng = 0)
            AND NOT (ROUND(p2.lat::numeric, 4) = 53.0444 AND ROUND(p2.lng::numeric, 4) = 158.6483)
           THEN 6371000 * acos(LEAST(1, GREATEST(-1,
             cos(radians(p1.lat)) * cos(radians(p2.lat)) * cos(radians(p2.lng) - radians(p1.lng)) +
             sin(radians(p1.lat)) * sin(radians(p2.lat))
           )))
           ELSE NULL
         END AS dist_m
       FROM places p1
       JOIN places p2
         ON p2.id > p1.id
        AND (
          -- ветка близких координат: обе точки с реальными (не 0,0 и не плейсхолдер) координатами
          ( p1.lat IS NOT NULL AND p1.lng IS NOT NULL
            AND NOT (p1.lat = 0 AND p1.lng = 0)
            AND NOT (ROUND(p1.lat::numeric, 4) = 53.0444 AND ROUND(p1.lng::numeric, 4) = 158.6483)
            AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
            AND NOT (p2.lat = 0 AND p2.lng = 0)
            AND NOT (ROUND(p2.lat::numeric, 4) = 53.0444 AND ROUND(p2.lng::numeric, 4) = 158.6483)
            AND p2.lat BETWEEN p1.lat - 0.01 AND p1.lat + 0.01
            AND p2.lng BETWEEN p1.lng - 0.02 AND p1.lng + 0.02 )
          -- ветка похожих имён: триграммное сходство, независимо от координат
          OR p1.name % p2.name
        )
       WHERE p1.merged_into_id IS NULL AND p2.merged_into_id IS NULL
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
     -- близкая пара засчитывается только при хоть каком-то совпадении имени (≥0.2),
     -- иначе соседство по координатам флагало бы разные объекты в одной точке.
     WHERE (pairs.dist_m IS NOT NULL AND pairs.dist_m <= 300 AND pairs.name_sim >= 0.2)
        OR pairs.name_sim >= 0.5
     ORDER BY pairs.dist_m ASC NULLS LAST, pairs.name_sim DESC
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
