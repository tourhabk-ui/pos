/**
 * POST /api/tools/equipment
 * Генерация чек-листа снаряжения по маршруту и дате.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { callAIWaterfall } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  routeId: z.string().uuid(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD'),
});

function getSeasonInfo(dateStr: string): { label: string; weather: string } {
  const month = new Date(dateStr).getMonth() + 1;
  if (month >= 12 || month <= 2) return { label: 'зима', weather: 'мороз -5...-15°C, снег, гололёд, метели' };
  if (month <= 4) return { label: 'весна', weather: 'холодно -5...+5°C, снег на высоте, слякоть' };
  if (month <= 6) return { label: 'поздняя весна / начало лета', weather: 'прохладно +5...+15°C, переменная облачность, возможен снег на высоте' };
  if (month <= 8) return { label: 'лето', weather: 'тепло +15...+25°C, туманы, внезапные дожди' };
  if (month <= 10) return { label: 'осень', weather: 'холодно +3...+10°C, дожди, первый снег, гололёд' };
  return { label: 'ранняя зима', weather: 'морозно -2...-10°C, первый снег, гололёд' };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.errors[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }

  const { routeId, dateFrom } = parsed.data;

  try {
    const routeResult = await query(
      `SELECT
         ark.id, ark.title, ark.description,
         ark.lat, ark.lng,
         ark.location_type, ark.activity_type, ark.category,
         ark.payload->>'difficulty'      AS difficulty,
         ark.payload->>'season'          AS season,
         ark.payload->'equipment'        AS equipment_json,
         ark.payload->>'duration_hours'  AS duration_hours,
         ark.payload->>'distance_km'     AS distance_km,
         ark.payload->>'elevation_gain_m' AS elevation_gain_m
       FROM agent_route_knowledge ark
       WHERE ark.id = $1`,
      [routeId]
    );

    if (!routeResult.rows.length) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }

    const r = routeResult.rows[0];
    const season = getSeasonInfo(dateFrom);

    const equipment: string[] = Array.isArray(r.equipment_json)
      ? (r.equipment_json as string[])
      : [];

    const parts: string[] = [
      `МАРШРУТ: ${r.title as string}`,
    ];
    if (r.location_type) parts.push(`ТИП МЕСТНОСТИ: ${r.location_type as string}`);
    if (r.activity_type) parts.push(`АКТИВНОСТЬ: ${r.activity_type as string}`);
    if (r.difficulty) parts.push(`СЛОЖНОСТЬ: ${r.difficulty as string}`);
    if (r.distance_km) parts.push(`РАССТОЯНИЕ: ${r.distance_km as string} км`);
    if (r.duration_hours) parts.push(`ДЛИТЕЛЬНОСТЬ: ${r.duration_hours as string} ч`);
    if (r.elevation_gain_m) parts.push(`НАБОР ВЫСОТЫ: ${r.elevation_gain_m as string} м`);
    parts.push(`ДАТА ПОЕЗДКИ: ${dateFrom} (${season.label})`);
    parts.push(`ПОГОДНЫЕ УСЛОВИЯ: ${season.weather}`);
    if (equipment.length) parts.push(`БАЗОВОЕ СНАРЯЖЕНИЕ МАРШРУТА: ${equipment.join(', ')}`);

    const userMessage = parts.join('\n') + `

Составь персональный чек-лист снаряжения строго по схеме JSON (без markdown):
{
  "summary": "1-2 предложения о главных особенностях подготовки к этому маршруту",
  "categories": [
    {"id":"clothing","name":"Одежда","items":[{"name":"...","required":true,"note":"опциональная пометка"}]},
    {"id":"footwear","name":"Обувь","items":[{"name":"...","required":true}]},
    {"id":"navigation","name":"Навигация и связь","items":[{"name":"...","required":true}]},
    {"id":"safety","name":"Безопасность и медицина","items":[{"name":"...","required":true}]},
    {"id":"food","name":"Питание и вода","items":[{"name":"...","required":true}]}
  ],
  "warnings": ["критичное предупреждение если есть, иначе пустой массив"],
  "tip": "один конкретный совет Кузьмича специфичный для этого маршрута"
}`;

    const messages = [
      {
        role: 'system' as const,
        content: 'Ты Кузьмич — опытный гид по Камчатке. Составляй точные, практичные чек-листы снаряжения. Учитывай сезон, рельеф и опасности маршрута. Отвечай ТОЛЬКО валидным JSON без markdown-блоков.',
      },
      { role: 'user' as const, content: userMessage },
    ];

    const aiText = await callAIWaterfall(messages);

    let checklist: unknown;
    try {
      const cleaned = aiText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      checklist = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ success: false, error: 'AI вернул некорректный ответ, попробуй ещё раз' }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      data: {
        routeTitle: r.title as string,
        dateFrom,
        season: season.label,
        checklist,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
