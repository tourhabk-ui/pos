/**
 * GET /api/planner/day-options — варианты дня плана для «Сравнить и заменить»
 * и «План Б» (супер-планер, 22.11). Только после входа, как весь планер
 * (lib/planner/require-session). Места и цена — из базы на дату дня, без кэша
 * (lib/planner/day-options-query). Заявка — не бронь: роут ничего не пишет.
 *
 * Query: mode (same|ground), activity_type (для same), zone, date, participants,
 *        exclude (id тура дня), limit (1–4, по умолчанию 3).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { plannerSession } from '@/lib/planner/require-session';
import { dayOptions } from '@/lib/planner/day-options-query';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  mode:          z.enum(['same', 'ground']),
  activity_type: z.string().min(1).max(50).optional(),
  zone:          z.enum(['avachinsky', 'western', 'eastern', 'northern', 'southern']),
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  participants:  z.coerce.number().int().min(1).max(60),
  exclude:       z.string().min(1).max(64).optional(),
  limit:         z.coerce.number().int().min(1).max(4).default(3),
}).refine((q) => q.mode === 'ground' || !!q.activity_type, { message: 'Для сравнения нужен вид занятия дня' });

export async function GET(req: NextRequest) {
  const session = await plannerSession(req);
  if (session instanceof NextResponse) return session;
  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    mode:          sp.get('mode') ?? undefined,
    activity_type: sp.get('activity_type') || undefined,
    zone:          sp.get('zone') ?? undefined,
    date:          sp.get('date') ?? undefined,
    participants:  sp.get('participants') ?? undefined,
    exclude:       sp.get('exclude') || undefined,
    limit:         sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Нужны вид занятия, зона, дата дня и число участников' }, { status: 400 });
  }
  const q = parsed.data;
  try {
    const options = await dayOptions({
      mode: q.mode, activityType: q.activity_type, zone: q.zone, date: q.date,
      participants: q.participants, excludeTourId: q.exclude, limit: q.limit,
    });
    return NextResponse.json({ success: true, options, orderNote: OFFER_ORDER_NOTE.ru });
  } catch (err) {
    // Отказ не выдаётся за «вариантов нет» (§4.0).
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[planner/day-options] варианты дня не прочитались', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ success: false, error: 'Варианты не загрузились, попробуйте позже' }, { status: 500 });
  }
}
