/**
 * PATCH /api/hub/carrier/vehicles/[id] — правка своей машины (#2862 этап C):
 * снять с линии / вернуть (is_active), число мест, заметка, название.
 *
 * Парк не модерируется: на витрине он назван числом и видом машин, цены там
 * нет. Чужая машина — 403, нет такой — 404, пустой patch — 400.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { FAILURE_STATUS, requireCarrier } from '@/lib/transfers/carrier-auth';
import { updateVehicle } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный id машины') });

const PatchSchema = z.object({
  is_active: z.boolean().optional(),
  seats: z.number().int().min(1).max(60).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  title: z.string().trim().min(2, 'Назовите машину').max(100).optional(),
}).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Нечего менять' });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный id машины' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const p = parsed.data;
  const r = await updateVehicle({
    partnerId: carrier.partnerId,
    vehicleId: parsedParams.data.id,
    patch: {
      ...(p.is_active !== undefined ? { isActive: p.is_active } : {}),
      ...(p.seats !== undefined ? { seats: p.seats } : {}),
      ...(p.notes !== undefined ? { notes: p.notes === '' ? null : p.notes } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}),
    },
  });
  if (!r.ok) {
    return NextResponse.json({ success: false, error: r.message, code: r.code }, { status: FAILURE_STATUS[r.code] ?? 500 });
  }
  return NextResponse.json({ success: true, data: r.value });
}
