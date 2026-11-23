/**
 * DELETE /api/guide/own/tours/[id]/edit — гид отзывает правку своего тура или
 * просьбу о публикации, пока администратор её не решил (план готовности
 * 23.11, этап 4).
 *
 * Черновик удаляется, витрина остаётся прежней. Тот же отзыв, что у
 * туроператора (`/api/hub/operator/tours/[id]/edit`): владение — в самом
 * запросе на удаление, чужой тур отвечает «правки нет».
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { withdrawTourEdit } from '@/lib/tours/moderation-store';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный номер тура' }, { status: 400 });
  }
  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  const outcome = await withdrawTourEdit(id, partnerId);
  if (outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не отозвано — база не ответила, попробуйте позже' }, { status: 503 });
  }
  if (outcome === 'none') {
    return NextResponse.json({ success: false, error: 'На проверке у этого тура ничего нет' }, { status: 404 });
  }
  return NextResponse.json({ success: true, message: 'Отозвано с проверки. На сайте — то, что было.' });
}
