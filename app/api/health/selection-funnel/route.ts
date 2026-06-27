/**
 * GET /api/health/selection-funnel?days=7
 * Health-метрика воронки подборок туров (аналог Qui-Quo): created → opened → tour_view → book_click.
 * Источник: tour_selections + tour_selection_events.
 * Примечание: завершённая бронь из подборки не атрибутируется (нет FK из operator_bookings
 * к подборке) — нижний этап воронки = клик «Записаться» (book_click).
 * Auth: requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // %, 1 знак
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({
    days: req.nextUrl.searchParams.get('days') ?? 7,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректный параметр days (1–90)' }, { status: 400 });
  }
  const { days } = parsed.data;

  // Подборки, созданные за период
  const createdRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::int AS cnt
     FROM tour_selections
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`,
    [days],
  );
  const created = Number(createdRes.rows[0]?.cnt ?? 0);

  // События по созданным за период подборкам: сколько уникальных подборок дошло до этапа
  const eventsRes = await pool.query<{
    opened: string;
    with_tour_view: string;
    with_book_click: string;
    tour_view_events: string;
    book_click_events: string;
  }>(
    `SELECT
       COUNT(DISTINCT e.selection_id) FILTER (WHERE e.event_type = 'open')::int       AS opened,
       COUNT(DISTINCT e.selection_id) FILTER (WHERE e.event_type = 'tour_view')::int  AS with_tour_view,
       COUNT(DISTINCT e.selection_id) FILTER (WHERE e.event_type = 'book_click')::int AS with_book_click,
       COUNT(*) FILTER (WHERE e.event_type = 'tour_view')::int                        AS tour_view_events,
       COUNT(*) FILTER (WHERE e.event_type = 'book_click')::int                       AS book_click_events
     FROM tour_selection_events e
     JOIN tour_selections s ON s.id = e.selection_id
     WHERE s.created_at >= NOW() - ($1 || ' days')::INTERVAL`,
    [days],
  );
  const ev = eventsRes.rows[0];
  const opened = Number(ev?.opened ?? 0);
  const withTourView = Number(ev?.with_tour_view ?? 0);
  const clicked = Number(ev?.with_book_click ?? 0);

  // status: warn если есть просмотры, но ни одного клика «Записаться»
  const status: 'ok' | 'warn' = opened > 0 && clicked === 0 ? 'warn' : 'ok';

  return NextResponse.json({
    period_days: days,
    funnel: {
      created,
      opened,
      tour_viewed: withTourView,
      book_clicked: clicked,
    },
    event_totals: {
      tour_view_events: Number(ev?.tour_view_events ?? 0),
      book_click_events: Number(ev?.book_click_events ?? 0),
    },
    conversions_pct: {
      created_to_opened: rate(opened, created),
      opened_to_tour_view: rate(withTourView, opened),
      tour_view_to_click: rate(clicked, withTourView),
    },
    note: 'Завершённая бронь не атрибутируется к подборке (нет FK operator_bookings → tour_selections). Нижний этап = клик «Записаться».',
    status,
    as_of: new Date().toISOString(),
  });
}
