/**
 * DELETE /api/hub/crm/keys/[id] — отозвать ключ MCP партнёра
 *
 * CRM фаза 1, шаг 1д-2 (#2325). Отозванный ключ не пускает со следующего
 * запроса: роут MCP проверяет `revoked_at` каждый раз. Строка остаётся —
 * кабинет показывает, что ключ был и когда отозван. Чужой и уже отозванный
 * ключ — 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { revokeAgentKey } from '@/lib/crm/agent-keys';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Id = z.string().uuid();

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ success: false, error: 'Ключ не найден' }, { status: 404 });
  try {
    const ok = await revokeAgentKey(ctx.partnerId, id.data, ctx.userId);
    if (!ok) return NextResponse.json({ success: false, error: 'Ключ не найден или уже отозван' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] ключ MCP не отозван, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось отозвать ключ, попробуйте позже' }, { status: 503 });
  }
}
