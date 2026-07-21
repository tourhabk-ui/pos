/**
 * lib/services/places-quality.ts
 *
 * Health-метрика полноты данных places после импорта (issue #226): точка без
 * координат бесполезна на офлайн-карте, без описания — не отвечает на вопрос
 * туриста. Считает долю заполненности lat/lng, description и category,
 * опционально фильтруя по источнику импорта (places.source_name).
 *
 * Уже слитые дубли (merged_into_id IS NOT NULL, см. PR #257) исключены —
 * это не самостоятельные записи, их пустота не показатель качества импорта.
 */

import { pool } from '@/lib/db-pool';

export interface PlacesQuality {
  total: number;
  coordsRatio: number;
  descriptionRatio: number;
  categoryRatio: number;
  missingCoordsIds: string[];
}

const MIN_DESCRIPTION_LENGTH = 300;
const MAX_MISSING_IDS = 200;

export async function computePlacesQuality(source?: string): Promise<PlacesQuality> {
  const params: string[] = [];
  let sourceFilter = '';
  if (source) {
    params.push(`%${source}%`);
    sourceFilter = ` AND source_name ILIKE $${params.length}`;
  }

  const totalsRes = await pool.query<{
    total: string; with_coords: string; with_description: string; with_category: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL) AS with_coords,
       COUNT(*) FILTER (WHERE description IS NOT NULL AND LENGTH(description) >= ${MIN_DESCRIPTION_LENGTH}) AS with_description,
       COUNT(*) FILTER (WHERE category IS NOT NULL) AS with_category
     FROM places
     WHERE merged_into_id IS NULL${sourceFilter}`,
    params,
  );

  const row = totalsRes.rows[0];
  const total = parseInt(row?.total ?? '0', 10);
  const withCoords = parseInt(row?.with_coords ?? '0', 10);
  const withDescription = parseInt(row?.with_description ?? '0', 10);
  const withCategory = parseInt(row?.with_category ?? '0', 10);

  const ratio = (part: number) => total > 0 ? Math.round((part / total) * 1000) / 10 : 0;

  const missingRes = await pool.query<{ id: string }>(
    `SELECT id::text FROM places
     WHERE merged_into_id IS NULL AND (lat IS NULL OR lng IS NULL)${sourceFilter}
     ORDER BY id
     LIMIT ${MAX_MISSING_IDS}`,
    params,
  );

  return {
    total,
    coordsRatio: ratio(withCoords),
    descriptionRatio: ratio(withDescription),
    categoryRatio: ratio(withCategory),
    missingCoordsIds: missingRes.rows.map(r => r.id),
  };
}
