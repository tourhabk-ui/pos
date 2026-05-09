/**
 * POST /api/trip-plans/[id]/refine
 * Чат-доработка итинерария через AI.
 * Турист пишет «сделай День 1 легче» — AI обновляет нужные дни и возвращает новый план.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { callAIFast } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  message:          z.string().min(1).max(500),
  routeTitle:       z.string().max(255),
  currentItinerary: z.record(z.unknown()),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length < 10) {
    return NextResponse.json({ success: false, error: 'Некорректный ID' }, { status: 400 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { message, routeTitle, currentItinerary } = parsed.data;

  // Проверяем что план существует
  const planRow = await query('SELECT id FROM trip_plans WHERE id = $1::uuid', [id]);
  if (!planRow.rows[0]) {
    return NextResponse.json({ success: false, error: 'План не найден' }, { status: 404 });
  }

  const prompt = `Ты — эксперт по туризму на Камчатке. Помогаешь туристу скорректировать план похода.

МАРШРУТ: ${routeTitle}

ТЕКУЩИЙ ПЛАН:
${JSON.stringify(currentItinerary, null, 2)}

ЗАПРОС ТУРИСТА: "${message}"

Задача:
1. Кратко ответь туристу (1-2 предложения) что именно изменил.
2. Если запрос меняет план — верни обновлённый JSON итинерария.
3. Если запрос информационный (вопрос, совет) — ответь и НЕ меняй план.

Ответ строго в JSON:
{
  "reply": "Что изменил или ответ на вопрос",
  "changed": true или false,
  "itinerary": { ...обновлённый план или null если не менялся... }
}

Пиши по-русски. Только JSON.`;

  const aiRaw = await callAIFast([{ role: 'user', content: prompt }]);

  let reply = 'Понял, внёс изменения в план.';
  let newItinerary: Record<string, unknown> | null = null;

  try {
    const match = aiRaw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed2 = JSON.parse(match[0]) as { reply?: string; changed?: boolean; itinerary?: Record<string, unknown> | null };
      reply = parsed2.reply ?? reply;
      if (parsed2.changed && parsed2.itinerary) {
        newItinerary = parsed2.itinerary;
        // Сохраняем обновлённый итинерарий в БД
        await query(
          'UPDATE trip_plans SET itinerary = $1::jsonb WHERE id = $2::uuid',
          [JSON.stringify(newItinerary), id]
        );
      }
    }
  } catch {
    reply = aiRaw.slice(0, 300);
  }

  return NextResponse.json({
    success: true,
    reply,
    itinerary: newItinerary,
  });
}
