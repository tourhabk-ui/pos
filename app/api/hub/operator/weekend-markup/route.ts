/**
 * Наценка оператора на выходные (сб, вс) — K.ai B1.
 * GET — туры и текущая наценка; POST { tourId, percent 1..30 } — поставить;
 * DELETE ?tourId= — снять. Цены — право can_edit_prices (как скидки).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';
import { MAX_OPERATOR_MARKUP } from '@/lib/tours/operator-discount';
import { listWeekendMarkups, setWeekendMarkup } from '@/lib/tours/operator-markup';

export const dynamic = 'force-dynamic';

const SaveSchema = z.object({
  tourId: z.coerce.number().int().positive(),
  percent: z.coerce.number().int().min(1).max(MAX_OPERATOR_MARKUP),
});

function failed(what: string, err: unknown) {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
  console.error(`[hub/operator/weekend-markup] ${what} (SQLSTATE ${code})`);
}

export async function GET(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, data: await listWeekendMarkups(pool, auth.partnerId) });
  } catch (err) {
    failed('список не отдан', err);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать наценки' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: `Наценка — целое число от 1 до ${MAX_OPERATOR_MARKUP}%` }, { status: 400 });
  }
  try {
    const done = await setWeekendMarkup(pool, auth.partnerId, [parsed.data.tourId], parsed.data.percent);
    if (done.length === 0) return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    failed('наценка не сохранена', err);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить наценку' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  const tourId = Number(request.nextUrl.searchParams.get('tourId'));
  if (!Number.isInteger(tourId) || tourId <= 0) return NextResponse.json({ success: false, error: 'tourId обязателен' }, { status: 400 });
  try {
    const done = await setWeekendMarkup(pool, auth.partnerId, [tourId], null);
    if (done.length === 0) return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    failed('наценка не снята', err);
    return NextResponse.json({ success: false, error: 'Не удалось снять наценку' }, { status: 500 });
  }
}
