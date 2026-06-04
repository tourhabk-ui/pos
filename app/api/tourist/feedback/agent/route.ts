/**
 * POST /api/tourist/feedback/agent
 * Публичный endpoint для оценки ответов AI-ассистента.
 * Пишет в ai_actions_log (action_type='agent_feedback').
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  chat_id:  z.union([z.string(), z.number()]).transform(String),
  rating:   z.enum(['good', 'bad']),
  intent:   z.string().max(200).optional(),
  comment:  z.string().max(1000).optional(),
});

// Простой IP-based rate limit: 10 запросов/мин
const ipMap = new Map<string, { count: number; reset: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipMap.get(ip);
  if (!entry || entry.reset < now) {
    ipMap.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Невалидные данные' }, { status: 400 });
  }

  const { chat_id, rating, intent, comment } = parsed.data;

  try {
    await pool.query(
      `INSERT INTO ai_actions_log (action_type, metadata, created_at)
       VALUES ('agent_feedback', $1, NOW())`,
      [JSON.stringify({ chat_id, rating, intent: intent ?? null, comment: comment ?? null, agent_id: 'kuzmich' })],
    );
    return NextResponse.json({ success: true }, { status: 201 });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка записи' }, { status: 500 });
  }
}
