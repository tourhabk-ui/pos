/**
 * POST /api/admin/enrich/places
 *
 * AI-обогащение карточек мест:
 * - description < 300 символов → расширяем до 500-700
 * - essence отсутствует → генерируем 1-2 предложения
 * - kuzmich_review отсутствует → голос Кузьмича
 * - best_season отсутствует → выводим из location_type
 *
 * Auth: requireAdmin
 * Body: { limit?: number, field?: 'description' | 'essence' | 'kuzmich_review' | 'all' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface PlaceRow {
  id: string;
  ark_id: string;
  name: string;
  description: string | null;
  essence: string | null;
  kuzmich_review: string | null;
  location_type: string | null;
  zone: string | null;
  district: string | null;
  lat: number;
  lng: number;
  best_season: string | null;
  difficulty_level: string | null;
  altitude_m: number | null;
}

const SEASON_BY_TYPE: Record<string, string> = {
  volcano:    'Июль–Сентябрь',
  geyser:     'Июнь–Сентябрь',
  hot_spring: 'Круглый год',
  lake:       'Июль–Август',
  mountain:   'Июль–Сентябрь',
  forest:     'Июнь–Октябрь',
  waterfall:  'Июнь–Сентябрь',
  beach:      'Июль–Август',
  bay:        'Июнь–Август',
  historical: 'Май–Октябрь',
  museum:     'Круглый год',
};

async function enrichDescription(place: PlaceRow): Promise<string> {
  const prompt = `Ты пишешь описание места для туристической платформы Камчатки.

Место: ${place.name}
Тип: ${place.location_type ?? 'природный объект'}
Район: ${place.district ?? place.zone ?? 'Камчатка'}
${place.altitude_m ? `Высота: ${place.altitude_m} м` : ''}
${place.difficulty_level ? `Сложность: ${place.difficulty_level}` : ''}
Текущее описание: ${place.description ?? '(отсутствует)'}

Напиши информативное описание 500-600 символов. Стиль: честный, конкретный, без рекламных клише. Упомяни что увидит турист, чем уникально место, что нужно знать. Только текст, без заголовков и списков.`;

  return await callAIFast([{ role: 'user', content: prompt }]);
}

async function enrichEssence(place: PlaceRow): Promise<string> {
  const prompt = `Одним-двумя предложениями (до 120 символов) опиши суть места "${place.name}" (${place.location_type ?? 'Камчатка'}) для туриста с рюкзаком. Без воды, только факт. Только текст.`;
  return await callAIFast([{ role: 'user', content: prompt }]);
}

async function enrichKuzmichReview(place: PlaceRow): Promise<string> {
  const prompt = `Ты Кузьмич — Хранитель Камчатки, старый опытный проводник. Напиши свой личный отзыв о месте "${place.name}" (${place.location_type ?? ''}, ${place.district ?? place.zone ?? 'Камчатка'}) от первого лица. 2-3 предложения, живой язык, конкретные детали. Не рекламируй — говори правду. Только текст.`;
  return await callAIFast([{ role: 'user', content: prompt }]);
}

export async function POST(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const body = await req.json().catch(() => ({}));
  const limit: number = Math.min(Number(body.limit) || 20, 50);
  const field: string = body.field || 'all';

  const results: { id: string; name: string; updated: string[]; error?: string }[] = [];

  // Выбираем места требующие обогащения
  const whereClause = field === 'description'
    ? `(p.description IS NULL OR char_length(p.description) < 300)`
    : field === 'essence'
    ? `p.essence IS NULL`
    : field === 'kuzmich_review'
    ? `p.kuzmich_review IS NULL`
    : `(p.description IS NULL OR char_length(p.description) < 300 OR p.essence IS NULL OR p.kuzmich_review IS NULL)`;

  const { rows } = await pool.query<PlaceRow>(
    `SELECT p.id, p.ark_id, p.name, p.description, p.essence, p.kuzmich_review,
            p.location_type, p.zone, p.district, p.lat, p.lng, p.best_season,
            sp.difficulty_level, sp.altitude_m
     FROM places p
     LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
     WHERE p.is_visible = TRUE AND ${whereClause}
     ORDER BY p.updated_at ASC
     LIMIT $1`,
    [limit],
  );

  for (const place of rows) {
    const updated: string[] = [];
    const updates: Record<string, string> = {};

    try {
      if ((field === 'all' || field === 'description') && (!place.description || place.description.length < 300)) {
        updates['description'] = await enrichDescription(place);
        updated.push('description');
      }

      if ((field === 'all' || field === 'essence') && !place.essence) {
        updates['essence'] = await enrichEssence(place);
        updated.push('essence');
      }

      if ((field === 'all' || field === 'kuzmich_review') && !place.kuzmich_review) {
        updates['kuzmich_review'] = await enrichKuzmichReview(place);
        updated.push('kuzmich_review');
      }

      if ((field === 'all' || field === 'best_season') && !place.best_season && place.location_type) {
        const season = SEASON_BY_TYPE[place.location_type];
        if (season) {
          updates['best_season'] = season;
          updated.push('best_season');
        }
      }

      if (Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = [place.id, ...Object.values(updates)];
        await pool.query(
          `UPDATE places SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
          values,
        );
      }

      results.push({ id: place.id, name: place.name, updated });
    } catch (err) {
      results.push({ id: place.id, name: place.name, updated, error: String(err) });
    }
  }

  const totalUpdated = results.filter(r => r.updated.length > 0).length;

  return NextResponse.json({
    success: true,
    processed: rows.length,
    updated: totalUpdated,
    results,
  });
}
