/**
 * GET /api/parks/[slug]
 * Публичный. Данные парка (справочник parks, migration 712) + маршруты внутри.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface ParkRow {
  slug: string;
  display_name: string;
  description: string | null;
  zone: string | null;
  mchs_phone: string | null;
  permit_url: string | null;
  search_term: string;
}

interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  difficulty: string | null;
  season: string | null;
  mchs_registration_required: boolean | null;
  hazards: string[] | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
    return NextResponse.json({ error: 'Парк не найден' }, { status: 404 });
  }

  try {
    const parkResult = await pool.query<ParkRow>(
      `SELECT slug, display_name, description, zone, mchs_phone, permit_url, search_term
       FROM parks
       WHERE slug = $1 AND is_active = true
       LIMIT 1`,
      [slug]
    );
    const park = parkResult.rows[0];
    if (!park) {
      return NextResponse.json({ error: 'Парк не найден' }, { status: 404 });
    }

    // Связь с маршрутами через ILIKE: park_name в kamchatka_routes заполнен
    // свободным текстом из visitkamchatka.ru
    let routes: RouteRow[] = [];
    try {
      const { rows } = await pool.query<RouteRow>(`
        SELECT id::text, title, description,
               distance_km::text, elevation_gain_m,
               duration_hours::text, difficulty, season,
               mchs_registration_required,
               COALESCE(hazards, ARRAY[]::TEXT[]) AS hazards
        FROM kamchatka_routes
        WHERE park_name ILIKE $1
          AND is_visible = TRUE
        ORDER BY view_count DESC NULLS LAST, title
        LIMIT 12
      `, [`%${park.search_term}%`]);
      routes = rows;
    } catch {
      // Маршруты не критичны для карточки парка — отдаём парк без них
    }

    return NextResponse.json({
      slug: park.slug,
      displayName: park.display_name,
      description: park.description,
      zone: park.zone,
      mchs_phone: park.mchs_phone,
      permit_url: park.permit_url,
      routes,
    });
  } catch {
    return NextResponse.json({ error: 'Ошибка загрузки парка' }, { status: 500 });
  }
}
