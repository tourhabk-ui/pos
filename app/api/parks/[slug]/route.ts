/**
 * GET /api/parks/[slug]
 * Публичный. Данные парка + маршруты внутри.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const PARK_MAP: Record<string, {
  searchTerm: string;
  displayName: string;
  zone: string;
  mchs_phone: string;
  permit_url: string | null;
  description: string;
}> = {
  nalychevo: {
    searchTerm: 'Налычево',
    displayName: 'Природный парк «Налычево»',
    zone: 'avachinsky',
    mchs_phone: '+7 (4152) 23-53-62',
    permit_url: 'https://nalychevo.ru',
    description: 'Один из самых посещаемых природных парков Камчатки. Термальные источники, вулканы Авачинской группы, маршруты любой сложности.',
  },
  bystrinskiy: {
    searchTerm: 'Быстринск',
    displayName: 'Природный парк «Быстринский»',
    zone: 'northern',
    mchs_phone: '+7 (4152) 23-53-62',
    permit_url: null,
    description: 'Самый большой природный парк Камчатки. Центральная Камчатка, долина реки Быстрой, медведи, нетронутая тайга.',
  },
  klyuchevskoy: {
    searchTerm: 'Ключевск',
    displayName: 'Природный парк «Ключевской»',
    zone: 'northern',
    mchs_phone: '+7 (41541) 2-10-33',
    permit_url: null,
    description: 'Кластер действующих вулканов — Ключевская Сопка (4750 м), Безымянный, Толбачик. Требует специальной подготовки и регистрации.',
  },
  komandorskiy: {
    searchTerm: 'Командорск',
    displayName: 'Командорский заповедник',
    zone: 'eastern',
    mchs_phone: '+7 (4152) 23-53-62',
    permit_url: 'https://komandorsky.ru',
    description: 'Острова Беринга и Медный. Котики, редкие птицы, Берингово море. Требует отдельного разрешения.',
  },
};

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
  const park = PARK_MAP[slug];
  if (!park) {
    return NextResponse.json({ error: 'Парк не найден' }, { status: 404 });
  }

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
    `, [`%${park.searchTerm}%`]);

    return NextResponse.json({
      slug,
      displayName: park.displayName,
      description: park.description,
      zone: park.zone,
      mchs_phone: park.mchs_phone,
      permit_url: park.permit_url,
      routes: rows,
    });
  } catch {
    return NextResponse.json({
      slug,
      displayName: park.displayName,
      description: park.description,
      zone: park.zone,
      mchs_phone: park.mchs_phone,
      permit_url: park.permit_url,
      routes: [],
    });
  }
}
