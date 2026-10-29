/**
 * POST /api/guide/own/dates — гид открывает даты своего тура. Тот же путь,
 * что у кабинета оператора (`openTourDates`, lib/tours/availability-open):
 * места не ниже уже записанных, горизонт и сезон — его правила. Цену на дату
 * гид здесь не меняет: цена тура — одна, из карточки.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { countResults, datesInRange, MAX_SLOTS_PER_DATE, openTourDates, tourHiddenText } from '@/lib/tours/availability-open';
import { kamchatkaToday } from '@/lib/seat-requests/core';

export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BodySchema = z.object({
  tourId: z.string().regex(/^\d{1,18}$/),
  startDate: z.string().regex(ISO),
  endDate: z.string().regex(ISO),
  slots: z.number().int().min(1).max(MAX_SLOTS_PER_DATE),
});

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Укажите тур, первую и последнюю дату и число мест' }, { status: 400 });
  }
  const { tourId, startDate, endDate, slots } = body.data;
  if (endDate < startDate) {
    return NextResponse.json({ success: false, error: 'Последняя дата раньше первой' }, { status: 400 });
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  const dates = datesInRange(startDate, endDate);
  if (dates.length === 0) {
    return NextResponse.json({ success: false, error: 'В диапазоне нет дат' }, { status: 400 });
  }

  const outcome = await openTourDates({
    operatorId: partnerId,
    tourId,
    rows: dates.map((date) => ({ date, slots, price: null })),
    mayPrice: false,
    inactiveTour: 'refuse',
    skipExisting: false,
    closedDates: 'reopen',
    // Прошедшие и дальше горизонта не открываются, вне сезона тура — тоже:
    // заявку вне сезона форма туриста всё равно не примет.
    today: kamchatkaToday(),
    enforceSeason: true,
  });
  if (!outcome.ok) {
    if (outcome.reason === 'tour_not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден среди ваших' }, { status: 404 });
    }
    if (outcome.reason === 'tour_inactive') {
      return NextResponse.json({ success: false, error: tourHiddenText(outcome.title) }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: 'Не удалось открыть даты — попробуйте позже' }, { status: 503 });
  }

  const n = countResults(outcome.perDate);
  const refused = outcome.perDate.filter((r) => r.result === 'refused_booked').length;
  const parts = [`Открыто дат: ${n.opened + n.reopened}`];
  if (n.updated > 0) parts.push(`обновлено: ${n.updated}`);
  if (n.already_open > 0) parts.push(`уже были открыты: ${n.already_open}`);
  if (refused > 0) parts.push(`не открыто ${refused}: записано больше мест`);
  const outOfSeason = outcome.perDate.filter((r) => r.result === 'refused_season').length;
  if (outOfSeason > 0) parts.push(`вне сезона тура: ${outOfSeason}`);
  const pastOrFar = outcome.perDate.filter((r) => r.result === 'refused_past' || r.result === 'refused_horizon').length;
  if (pastOrFar > 0) parts.push(`прошедшие или дальше года: ${pastOrFar}`);
  return NextResponse.json({ success: true, message: parts.join(', ') });
}
