/**
 * POST /api/safety/checkin  — создать чекин
 * GET  /api/safety/checkin?token=  — статус по токену
 * DELETE /api/safety/checkin?token= — отменить по токену
 *
 * AUTH: намеренно публичный — туристы без аккаунта должны иметь возможность
 * зарегистрировать чекин (аналогично /api/safety/sos).
 * Защита: cancel_token (32 hex байта, UNIQUE) — единственный секрет для мутаций.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

// Rate limit: 3 check-ins per 10 minutes per IP (in-memory, same pattern as /api/safety/sos)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const MIN_DEADLINE_MS = 30 * 60 * 1000; // deadline must be at least 30 min in the future

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_MS);
  rateLimitMap.set(ip, hits);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  // Purge IPs older than 1 hour
  for (const [k, ts] of rateLimitMap.entries()) {
    if (ts.every(t => now - t > 60 * 60 * 1000)) rateLimitMap.delete(k);
  }
  return false;
}

const CreateSchema = z.object({
  tourist_name:       z.string().min(2).max(100),
  route_name:         z.string().min(2).max(200),
  return_deadline:    z.string().datetime(),
  emergency_name:     z.string().min(2).max(100),
  emergency_phone:    z.string().max(30).optional(),
  emergency_telegram: z.string().max(64).optional(),
  last_lat:           z.number().min(-90).max(90).optional(),
  last_lng:           z.number().min(-180).max(180).optional(),
}).refine(d => d.emergency_phone || d.emergency_telegram, {
  message: 'Укажите телефон или Telegram экстренного контакта',
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown';

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Слишком много запросов. Попробуйте позже.' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const d = parsed.data;
  const deadline = new Date(d.return_deadline);
  if (deadline.getTime() - Date.now() < MIN_DEADLINE_MS) {
    return NextResponse.json(
      { error: 'Время возврата должно быть минимум через 30 минут' },
      { status: 400 }
    );
  }

  const { rows } = await pool.query<{ id: string; cancel_token: string }>(
    `INSERT INTO tourist_checkins
       (tourist_name, route_name, return_deadline,
        emergency_name, emergency_phone, emergency_telegram,
        last_lat, last_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, cancel_token`,
    [d.tourist_name, d.route_name, d.return_deadline,
     d.emergency_name, d.emergency_phone ?? null, d.emergency_telegram ?? null,
     d.last_lat ?? null, d.last_lng ?? null]
  );

  const { id, cancel_token } = rows[0];
  return NextResponse.json({ success: true, id, cancel_token }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token');
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    return NextResponse.json({ error: 'Некорректный токен' }, { status: 400 });
  }

  const { rows } = await pool.query<{
    tourist_name: string; route_name: string; return_deadline: Date;
    status: string; emergency_name: string;
  }>(
    `SELECT tourist_name, route_name, return_deadline, status, emergency_name
     FROM tourist_checkins WHERE cancel_token = $1`,
    [token]
  );

  if (!rows[0]) {
    return NextResponse.json({ error: 'Чекин не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token');
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    return NextResponse.json({ error: 'Некорректный токен' }, { status: 400 });
  }

  const { rowCount } = await pool.query(
    `UPDATE tourist_checkins
     SET status = 'cancelled', cancelled_at = NOW()
     WHERE cancel_token = $1 AND status = 'active'`,
    [token]
  );

  if (!rowCount) {
    return NextResponse.json({ error: 'Чекин не найден или уже отменён' }, { status: 404 });
  }

  return NextResponse.json({ success: true, message: 'Чекин отменён' });
}
