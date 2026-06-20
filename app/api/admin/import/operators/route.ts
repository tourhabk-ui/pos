/**
 * POST /api/admin/import/operators
 *
 * Три действия в одном endpoint:
 *   scrape_operators — парсит visitkamchatka.ru/tour-operators/ → partners
 *   scrape_tours     — парсит tours.visitkamchatka.ru/tours → operator_tours + tour_availability
 *   scan_tg          — читает TG-группы операторов → agent_memory (наличие мест)
 *   scan_tg_group    — читает конкретную TG-группу (body.group_username обязателен)
 *
 * Auth: requireAdmin
 * Timeweb cron или ручной запуск из /hub/admin
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { scrapeOperatorDirectory } from '@/lib/services/visitkamchatka-operators';
import { scrapeTourMarketplace } from '@/lib/services/tours-visitkamchatka';
import { scanAllOperatorGroups, fetchGroupAvailability } from '@/lib/telegram/operator-availability';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BodySchema = z.object({
  action: z.enum(['scrape_operators', 'scrape_tours', 'scan_tg', 'scan_tg_group']),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  activity: z.string().optional(),
  group_username: z.string().optional(),
  hours_back: z.number().int().min(1).max(168).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation error', details: parsed.error.flatten() }, { status: 400 });
  }

  const { action, date_from, date_to, activity, group_username, hours_back } = parsed.data;
  const t0 = Date.now();

  try {
    if (action === 'scrape_operators') {
      const result = await scrapeOperatorDirectory();
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scrape_tours') {
      const result = await scrapeTourMarketplace({
        dateFrom: date_from,
        dateTo: date_to,
        activity,
      });
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scan_tg') {
      const result = await scanAllOperatorGroups(hours_back ?? 72);
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    if (action === 'scan_tg_group') {
      if (!group_username) {
        return NextResponse.json({ error: 'group_username required for scan_tg_group' }, { status: 400 });
      }
      const result = await fetchGroupAvailability(group_username, hours_back ?? 72);
      return NextResponse.json({
        ok: true,
        action,
        duration_ms: Date.now() - t0,
        ...result,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg, duration_ms: Date.now() - t0 }, { status: 500 });
  }
}
