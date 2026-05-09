/**
 * POST /api/trip-plans/generate
 * AI генерирует день-за-днём план по маршруту Камчатки.
 * Анонимный — session_id из тела запроса.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { callAIWaterfall } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  routeId:    z.string().uuid(),
  sessionId:  z.string().min(8).max(64),
  startDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days:       z.number().int().min(1).max(14).default(1),
  experience: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate'),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { routeId, sessionId, startDate, days, experience } = parsed.data;

  // ── 1. Загрузить маршрут из БД ─────────────────────────────────────────────
  const routeRes = await query(
    `SELECT r.id, r.title, r.description, r.zone, r.difficulty, r.distance_km,
            r.elevation_gain_m, r.duration_hours, r.season, r.route_type,
            r.hazards, r.equipment, r.mchs_registration_required, r.mchs_phone,
            r.park_name, r.flora_fauna
     FROM kamchatka_routes r
     WHERE r.id = $1::uuid`,
    [routeId]
  );
  if (!routeRes.rows[0]) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }
  const route = routeRes.rows[0];

  // ── 2. Точки маршрута ────────────────────────────────────────────────────────
  const wpRes = await query(
    `SELECT w.position, p.name, p.description, p.location_type,
            p.lat, p.lng,
            sp.altitude_m, sp.hazard_types, sp.difficulty_level
     FROM route_waypoints w
     JOIN places p ON p.id = w.place_id
     LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
     WHERE w.route_id = $1::uuid
     ORDER BY w.position`,
    [routeId]
  );
  const waypoints = wpRes.rows;

  // ── 3. Строим промпт ─────────────────────────────────────────────────────────
  const experienceMap: Record<string, string> = {
    beginner:     'начинающий турист (первые походы, средняя физическая подготовка)',
    intermediate: 'опытный турист (несколько сезонов, хорошая физическая форма)',
    advanced:     'опытный горный турист (многолетний опыт, высокая выносливость)',
  };

  const wpText = waypoints.length > 0
    ? waypoints.map(w =>
        `- Позиция ${w.position}: ${w.name} (${w.location_type ?? 'точка'})`
        + (w.altitude_m ? `, ${w.altitude_m}м` : '')
        + ((w.hazard_types as string[] | null)?.length ? `, опасности: ${(w.hazard_types as string[]).join(', ')}` : '')
      ).join('\n')
    : 'Точки маршрута не указаны в базе данных.';

  const prompt = `Ты — эксперт по туризму на Камчатке. Составь детальный план похода.

МАРШРУТ: ${route.title}
Район: ${route.zone ?? 'Камчатка'}
Сложность: ${route.difficulty ?? 'средняя'}
Расстояние: ${route.distance_km ? `${route.distance_km} км` : 'не указано'}
Набор высоты: ${route.elevation_gain_m ? `${route.elevation_gain_m} м` : 'не указан'}
Длительность: ${route.duration_hours ? `${route.duration_hours} ч` : 'не указана'}
Сезон: ${route.season ?? 'лето'}
Тип: ${route.route_type ?? 'маршрут'}
Опасности: ${(route.hazards as string[] | null)?.join(', ') || 'нет данных'}
Снаряжение: ${(route.equipment as string[] | null)?.join(', ') || 'нет данных'}
Флора/фауна: ${route.flora_fauna ?? 'типичная для Камчатки'}
МЧС обязательно: ${route.mchs_registration_required ? 'ДА' : 'нет'}

ТОЧКИ НА МАРШРУТЕ:
${wpText}

ТУРИСТ: ${experienceMap[experience]}
ПЛАНИРУЕМЫХ ДНЕЙ: ${days}
${startDate ? `ДАТА СТАРТА: ${startDate}` : ''}

Составь план в виде JSON (только JSON, без пояснений):
{
  "title": "краткое название плана",
  "summary": "2-3 предложения о маршруте",
  "days": [
    {
      "day": 1,
      "title": "День 1: ...",
      "distanceKm": 8.5,
      "elevationGain": 400,
      "estimatedHours": 5,
      "notes": "подробное описание дня (3-5 предложений с конкретикой Камчатки)",
      "hazards": ["опасность 1", "опасность 2"],
      "checkpoints": ["Старт у парковки", "Смотровая 1400м", "Лагерь"],
      "camp": "место ночёвки или финиш"
    }
  ],
  "equipment": ["снаряжение 1", "снаряжение 2"],
  "warnings": ["предупреждение 1"],
  "bestTime": "лучшее время суток для старта",
  "mchsNote": "${route.mchs_registration_required ? `Обязательно зарегистрируйтесь в МЧС: ${route.mchs_phone ?? '+7 (4152) 23-53-62'}` : ''}"
}

Пиши по-русски. Конкретика Камчатки — не общие слова. JSON должен быть валидным.`;

  const aiRaw = await callAIWaterfall([
    { role: 'user', content: prompt },
  ]);

  // ── 4. Парсим JSON из ответа ─────────────────────────────────────────────────
  let itinerary: unknown = {};
  try {
    const match = aiRaw.match(/\{[\s\S]*\}/);
    if (match) itinerary = JSON.parse(match[0]);
  } catch {
    itinerary = { raw: aiRaw };
  }

  // ── 5. Сохраняем в БД ────────────────────────────────────────────────────────
  const insertRes = await query(
    `INSERT INTO trip_plans (route_id, session_id, title, start_date, days, experience, itinerary)
     VALUES ($1::uuid, $2, $3, $4::date, $5, $6, $7::jsonb)
     RETURNING id, created_at`,
    [
      routeId,
      sessionId,
      (itinerary as Record<string, unknown>)?.title as string ?? route.title,
      startDate ?? null,
      days,
      experience,
      JSON.stringify(itinerary),
    ]
  );

  const plan = insertRes.rows[0];

  return NextResponse.json({
    success: true,
    data: {
      id: plan.id as string,
      createdAt: plan.created_at as string,
      routeId: routeId as string,
      routeTitle: route.title as string,
      itinerary,
    },
  });
}
