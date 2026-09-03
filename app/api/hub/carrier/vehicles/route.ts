/**
 * Парк перевозчика.
 *   GET  /api/hub/carrier/vehicles — свои машины
 *   POST /api/hub/carrier/vehicles — добавить машину
 *
 * Новый путь, не адрес мёртвого модуля (/api/transfer-operator/*): старый
 * URL, оживший с новой семантикой, — «сломанное выглядит менее сломанным» на
 * уровне маршрутизации (решение владельца 01.09). Схема — миграция 926,
 * логика — lib/transfers/service.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { listVehicles, addVehicle } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const VehicleSchema = z.object({
  kind: z.enum(['jeep', 'vahtovka', 'minibus', 'other']),
  title: z.string().trim().min(2, 'Назовите машину').max(100),
  seats: z.number().int().min(1).max(60),
  notes: z.string().trim().max(300).optional().nullable(),
});

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;
  try {
    const vehicles = await listVehicles(carrier.partnerId);
    return NextResponse.json({ success: true, data: vehicles });
  } catch (err) {
    console.error('[carrier/vehicles] list:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать парк' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const parsed = VehicleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  try {
    const vehicle = await addVehicle({ partnerId: carrier.partnerId, ...parsed.data });
    return NextResponse.json({ success: true, data: vehicle }, { status: 201 });
  } catch (err) {
    console.error('[carrier/vehicles] add:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Машина не добавлена' }, { status: 503 });
  }
}
