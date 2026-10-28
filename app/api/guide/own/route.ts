/**
 * GET /api/guide/own — раздел «Свои туры» кабинета гида: туры, которые гид
 * продаёт сам, брони и заявки по ним (lib/guides/own-tours).
 *
 * Кто вправе — карточка вошедшего гида (`getGuidePartnerId`), не параметр.
 * Каждый список читается отдельно и не прочитанный — null, а не пустой:
 * «не загрузилось» и «нет ни одной» — разные ответы (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { loadOwnBookings, loadOwnLeads, loadOwnTours } from '@/lib/guides/own-tours';

export const dynamic = 'force-dynamic';

async function settle<T>(name: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    const err = e as { code?: string };
    console.error(`[guide/own] ${name} не прочитаны:`, `sqlstate=${err?.code ?? 'нет'}`);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  const [tours, bookings, leads] = await Promise.all([
    settle('туры', loadOwnTours(partnerId)),
    settle('брони', loadOwnBookings(partnerId)),
    settle('заявки', loadOwnLeads(partnerId)),
  ]);
  return NextResponse.json(
    { success: true, data: { tours, bookings, leads } },
    { headers: { 'cache-control': 'no-store' } },
  );
}
