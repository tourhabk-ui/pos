/**
 * POST /api/p/[code]/event — трекинг событий на странице подборки
 * Публичный endpoint, без авторизации. Логирует open/tour_view/book_click.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Анонимный INSERT в статистику: без рубежа один клиент мог накрутить
// просмотры подборки. Порог щедрый — обычная сессия столько не даёт.
const eventLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

interface RouteParams { params: Promise<{ code: string }> }

const EventSchema = z.object({
  event_type: z.enum(['open', 'tour_view', 'book_click']),
  item_id:    z.string().uuid().optional(),
});

export async function POST(req: NextRequest, { params }: RouteParams) {
  // 204 как и на прочие отказы: трекинг не должен ломать страницу.
  if (!eventLimiter.check(getClientIp(req.headers))) return new NextResponse(null, { status: 204 });

  const { code } = await params;
  if (!code || code.length > 20) return new NextResponse(null, { status: 204 });

  let body: unknown;
  try { body = await req.json(); } catch { return new NextResponse(null, { status: 204 }); }

  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 204 });

  // Look up selection — fail silently if not found (no info leak)
  const selRow = await pool.query<{ id: string }>(
    `SELECT id FROM tour_selections WHERE code = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [code],
  );
  if (!selRow.rows[0]) return new NextResponse(null, { status: 204 });

  const selectionId = selRow.rows[0].id;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? null;
  const ua = req.headers.get('user-agent')?.slice(0, 200) ?? null;

  // Fire-and-forget insert — never block response
  pool.query(
    `INSERT INTO tour_selection_events (selection_id, item_id, event_type, visitor_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [selectionId, parsed.data.item_id ?? null, parsed.data.event_type, ip, ua],
  ).catch(() => {});

  return new NextResponse(null, { status: 204 });
}
