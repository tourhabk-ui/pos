/**
 * Календарь машины проката в кабинете на сайте.
 *   GET  /api/hub/carrier/rental/calendar?offer=<id> — 30 дней по Камчатке
 *   POST /api/hub/carrier/rental/calendar { offerId, day, busy } — отметка дня
 *
 * День без отметки — «не отмечено», а не «свободна» (lib/rental/car-calendar).
 * Отметка пишется только своей машине (setOperatorMark сверяет владельца) и
 * только в пределах 30 дней; вне пилота — не пишется вовсе, как в чате.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { withinHorizon } from '@/lib/rental/car-calendar';
import { loadCalendarCars, setOperatorMark } from '@/lib/rental/car-calendar-store';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { loadCarDays, loadRentalActor } from '@/lib/rental/web-cabinet';

export const dynamic = 'force-dynamic';

const OfferId = z.string().uuid();
const MarkSchema = z.object({
  offerId: OfferId,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  busy: z.boolean(),
});

const READ_FAILED = 'Не удалось прочитать календарь. Не говорю, что машина свободна. Обновите страницу.';

/** Машина его прайса? Отказ базы — отдельный исход. */
async function ownsCar(partnerId: string, offerId: string): Promise<boolean | 'db_error'> {
  const cars = await loadCalendarCars(partnerId, '');
  if (cars.outcome === 'db_error') return 'db_error';
  return cars.cars.some((c) => c.id === offerId);
}

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const offer = OfferId.safeParse(request.nextUrl.searchParams.get('offer'));
  if (!offer.success) {
    return NextResponse.json({ success: false, error: 'Не указана машина' }, { status: 400 });
  }
  const owned = await ownsCar(carrier.partnerId, offer.data);
  if (owned === 'db_error') return NextResponse.json({ success: false, error: READ_FAILED }, { status: 503 });
  if (!owned) {
    return NextResponse.json({ success: false, error: 'Эта машина не в вашем прайсе' }, { status: 404 });
  }
  const read = await loadCarDays(offer.data, new Date());
  if (read === 'db_error') return NextResponse.json({ success: false, error: READ_FAILED }, { status: 503 });
  return NextResponse.json({ success: true, data: read }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const parsed = MarkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверная отметка: машина, день и «занята» или «свободна»' }, { status: 400 });
  }
  const { offerId, day, busy } = parsed.data;

  const actor = await loadRentalActor(carrier.partnerId);
  if (actor.outcome !== 'ok') {
    return NextResponse.json({ success: false, error: 'Не удалось прочитать карточку. Отметка не записана.' }, { status: 503 });
  }
  if (!isRentalPilotSlug(actor.actor.slug)) {
    return NextResponse.json({ success: false, error: 'Календарь проката для вашей карточки пока не ведётся. Отметка не записана.' }, { status: 403 });
  }
  if (!withinHorizon(kamchatkaDate(new Date()), day)) {
    return NextResponse.json({ success: false, error: 'Этот день вне ближайших 30. Отметка не записана.' }, { status: 400 });
  }

  const wrote = await setOperatorMark(carrier.partnerId, offerId, day, busy);
  if (wrote === 'not_yours') {
    return NextResponse.json({ success: false, error: 'Эта машина не в вашем прайсе. Отметка не записана.' }, { status: 404 });
  }
  if (wrote === 'db_error') {
    return NextResponse.json({ success: false, error: 'Отметку записать не удалось. Попробуйте ещё раз.' }, { status: 503 });
  }
  return NextResponse.json({ success: true });
}
