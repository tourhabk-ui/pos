/**
 * GET /api/admin/crm/contacts/[id] — карточка клиента любого партнёра для
 * администратора (CRM #2325). Только чтение: правит клиента его партнёр.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { getContactCardForAdmin } from '@/lib/crm/admin-queries';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
  }
  try {
    const card = await getContactCardForAdmin(id);
    if (!card) return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    return NextResponse.json({ success: true, data: card });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm/admin] карточка клиента не прочитана, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось открыть клиента, попробуйте позже' }, { status: 503 });
  }
}
