/**
 * Поездки перевозчика.
 *   GET  /api/hub/carrier/trips — свои поездки (с занятыми/свободными/запрошенными местами)
 *   POST /api/hub/carrier/trips — завести поездку
 *
 * Расписаний нет: поездка — это машина, день и направление под заказ
 * (владелец, 01.09). Второй поездке той же машины на тот же день откажет
 * уникальный индекс — сервис переводит 23505 в исход day_taken, и он
 * доходит сюда как 409 с именем.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier, FAILURE_STATUS } from '@/lib/transfers/carrier-auth';
import { createTrip, listTripsForPartner } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const TripSchema = z.object({
  vehicle_id: z.string().uuid(),
  trip_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'),
  from_text: z.string().trim().min(2).max(200),
  to_text: z.string().trim().min(2).max(200),
  // places.id на проде — TEXT, а не UUID (аудит 28.07; UUID у места лежит в
  // ark_id). Требовать здесь uuid значило бы отвергать настоящие id мест.
  to_place_id: z.string().trim().min(1).max(100).optional().nullable(),
  to_route_id: z.string().uuid().optional().nullable(),
  departure_note: z.string().trim().max(100).optional().nullable(),
  seats_total: z.number().int().min(1).max(60),
  price_per_seat: z.number().positive().optional().nullable(),
  is_published: z.boolean().optional(),
  comment: z.string().trim().max(500).optional().nullable(),
});

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;
  try {
    const trips = await listTripsForPartner(carrier.partnerId);
    return NextResponse.json({ success: true, data: trips });
  } catch (err) {
    console.error('[carrier/trips] list:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать поездки' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const parsed = TripSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const result = await createTrip({
    partnerId: carrier.partnerId,
    vehicleId: d.vehicle_id,
    tripDate: d.trip_date,
    fromText: d.from_text,
    toText: d.to_text,
    toPlaceId: d.to_place_id ?? null,
    toRouteId: d.to_route_id ?? null,
    departureNote: d.departure_note ?? null,
    seatsTotal: d.seats_total,
    pricePerSeat: d.price_per_seat ?? null,
    isPublished: d.is_published ?? false,
    comment: d.comment ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, code: result.code, error: result.message },
      { status: FAILURE_STATUS[result.code] ?? 500 },
    );
  }
  return NextResponse.json({ success: true, data: result.value }, { status: 201 });
}
