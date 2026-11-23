/**
 * DELETE /api/hub/operator/tours/[id]/edit — владелец отзывает правку,
 * которая ждёт проверки (план готовности 23.11, этап 4).
 *
 * Черновик удаляется, витрина остаётся прежней. Одобренную или возвращённую
 * правку отозвать нельзя: она уже решена.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { withdrawTourEdit } from '@/lib/tours/moderation-store';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный id тура' }, { status: 400 });
  }
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const partnerId = await getOperatorPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });

  const outcome = await withdrawTourEdit(id, partnerId);
  if (outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не удалось отозвать правку, попробуйте позже' }, { status: 503 });
  }
  if (outcome === 'none') {
    return NextResponse.json({ success: false, error: 'Правки на проверке у этого тура нет' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
