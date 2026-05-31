/**
 * POST /api/tourist/feedback/agent
 *
 * Записывает оценку ответа Кузьмича в ai_actions_log.
 * Публичный endpoint: Telegram-пользователи без аккаунта должны иметь возможность
 * оставлять обратную связь через inline-кнопки 👍/👎.
 *
 * Данные читает FeedbackLoop (lib/agents/learning/feedback-loop.ts):
 *   SELECT ... FROM ai_actions_log WHERE action_type = 'agent_feedback'
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

// Rate limit: 10 feedbacks per minute per IP
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_MS);
  rateLimitMap.set(ip, hits);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  for (const [k, ts] of rateLimitMap.entries()) {
    if (ts.every(t => now - t > 10 * 60 * 1000)) rateLimitMap.delete(k);
  }
  return false;
}

const FeedbackSchema = z.object({
  chat_id: z.union([z.string(), z.number()]).transform(String),
  rating: z.enum(['good', 'bad']),
  intent: z.string().max(200).optional(),
  comment: z.string().max(1000).optional(),
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown';

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { chat_id, rating, intent, comment } = parsed.data;

  await pool.query(
    `INSERT INTO ai_actions_log (action_type, metadata, created_at)
     VALUES ('agent_feedback', $1::jsonb, NOW())`,
    [JSON.stringify({ chat_id, rating, intent: intent ?? null, comment: comment ?? null, agent_id: 'kuzmich' })]
  );

  return NextResponse.json({ success: true }, { status: 201 });
}
