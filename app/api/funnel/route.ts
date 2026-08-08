/**
 * POST /api/funnel — публичный маяк воронки (Эволюция 3.0, п.5).
 *
 * AUTH: публичный by design — маяк с витрины, у посетителя нет сессии.
 * Пишет ТОЛЬКО счётные события верха воронки (catalog_view / tour_view /
 * booking_start), никаких персональных данных: вместо IP — усечённый
 * sha256(сутки + ip + ua) с суточной солью, склеить дни или восстановить
 * адрес нельзя. Дедуп: тот же посетитель + шаг + сущность чаще раза в час
 * не считается (перезагрузки страницы — не «рост трафика»).
 *
 * Читает журнал ночной объектив scanFunnel (growth-agent) — самое верхнее
 * сломанное звено воронки становится находкой эволюции.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  step: z.enum(['catalog_view', 'tour_view', 'booking_start']),
  entity_id: z.string().max(64).nullish(),
});

/** Анонимный суточный хэш посетителя: sha256(YYYY-MM-DD + ip + ua), 32 hex. */
function visitorHash(req: NextRequest): string {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
  const ua = req.headers.get('user-agent') ?? '';
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${day}|${ip}|${ua}`).digest('hex').slice(0, 32);
}

export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат события' }, { status: 400 });
  }

  try {
    const hash = visitorHash(request);
    await pool.query(
      `INSERT INTO funnel_events (step, entity_id, visitor_hash)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM funnel_events
           WHERE step = $1
             AND entity_id IS NOT DISTINCT FROM $2
             AND visitor_hash = $3
             AND created_at > NOW() - INTERVAL '60 minutes'
        )`,
      [parsed.step, parsed.entity_id ?? null, hash],
    );
  } catch { /* маяк не должен отдавать 500 витрине — событие просто теряется */ }

  return new NextResponse(null, { status: 204 });
}
