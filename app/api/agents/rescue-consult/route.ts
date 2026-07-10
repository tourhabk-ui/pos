/**
 * POST /api/agents/rescue-consult — консультация «AI Спасатель — Начальник SAR»
 * для админ-дашборда безопасности (/hub/admin/safety). Admin-only.
 *
 * Отличается от публичного /api/safety/rescue-chat: здесь адресат — оператор
 * МЧС/координатор SAR (не пострадавший турист), тон оперативно-штабной. AI
 * только через callAIWaterfall (CLAUDE.md §4). Body: { message, history }.
 * Ответ: { reply } либо { error }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { callAIWaterfall } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(20).optional().default([]),
});

const SAR_SYSTEM = `Ты — AI-помощник Начальника поисково-спасательных операций (SAR) Камчатки. Твой собеседник — координатор МЧС/ПСО, а не пострадавший. Помогаешь оценивать обстановку, планировать спасательные операции, подбирать протоколы (МЧС России, ГОСТ Р 22.3.02, ПАСС Камчатки, WFA/WFR).

Стиль: оперативно-штабной, по существу, нумерованные шаги. Без воды.
- Опираешься на факты, которые дал координатор. Не выдумывай инциденты, координаты, погоду — если данных нет, прямо скажи «данных нет, уточните».
- Экстренные телефоны Камчатки: 112, ПАСС 8 (4152) 41-03-03, ЭКОСПАС 8 (4152) 42-40-27.
- Приоритет: жизнь → здоровье → эвакуация → связь.
Язык: русский.`;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SAR_SYSTEM },
    ...data.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: data.message },
  ];

  try {
    const reply = await callAIWaterfall(messages);
    if (!reply) {
      return NextResponse.json({ error: 'AI Спасатель временно недоступен. При угрозе жизни — 112.' }, { status: 503 });
    }
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ error: 'AI Спасатель временно недоступен. При угрозе жизни — 112.' }, { status: 503 });
  }
}
