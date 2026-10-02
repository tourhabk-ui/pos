/**
 * Активные природные парки (справочник parks, миграция 712) — один запрос
 * для API и для серверной отрисовки каталога.
 */
import { pool } from '@/lib/db-pool';

export interface ParkLite {
  slug: string;
  displayName: string;
}

export interface ParkListItem extends ParkLite {
  description: string | null;
  zone: string | null;
}

export async function listActiveParks(): Promise<ParkListItem[]> {
  const { rows } = await pool.query<{
    slug: string;
    display_name: string;
    description: string | null;
    zone: string | null;
  }>(
    `SELECT slug, display_name, description, zone
     FROM parks
     WHERE is_active = true
     ORDER BY display_name`
  );
  return rows.map(r => ({
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    zone: r.zone,
  }));
}
