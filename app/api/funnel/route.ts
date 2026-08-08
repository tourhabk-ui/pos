/**
 * POST /api/funnel — публичный маяк ВЗАИМОДЕЙСТВИЙ воронки (Эволюция 3.0, п.5).
 *
 * AUTH: публичный by design — маяк с витрины, у посетителя нет сессии.
 *
 * Здесь только события, которых НЕТ в собственной метрике страниц: просмотры
 * (каталог, карточка тура) уже пишет PageViewTracker → page_views, и объектив
 * scanFunnel читает их оттуда. Первая версия этого роута дублировала просмотры
 * своим маяком — владелец 08.08: «у нас была настроена своя метрика».
 *
 * Единственный шаг — booking_start: первое касание формы брони. Это
 * взаимодействие, а не переход, в page_views его по построению нет.
 *
 * Без PII: тот же суточный visitorHash с секретной солью, что у page_views
 * (152-ФЗ), боты отсекаются тем же bot-detect, флуд — тем же rate-limiter.
 * Дедуп: посетитель+тур чаще раза в час не считается. Сбой — всегда 204:
 * маяк не должен ломать витрину.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  step: z.enum(['booking_start']),
  entity_id: z.string().max(64).nullish(),
});

const funnelLimiter = createRateLimiter({ windowMs: 10_000, max: 10 });

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!funnelLimiter.check(ip)) {
    return new NextResponse(null, { status: 429 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат события' }, { status: 400 });
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  // Краулер, трогающий форму, — не воронка; строку не пишем вовсе
  // (в отличие от page_views, где бот-строки нужны для SEO-наблюдений).
  if (isBotUserAgent(userAgent)) return new NextResponse(null, { status: 204 });

  try {
    const hash = visitorHash(ip, userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
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
