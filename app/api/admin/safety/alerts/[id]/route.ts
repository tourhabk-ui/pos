/**
 * PATCH /api/admin/safety/alerts/[id] — снять действующее предупреждение.
 *
 * Именно снять, а не удалить: снятое ограничение — такой же факт, как
 * введённое. По нему потом восстанавливают, что и когда было закрыто, и
 * удаление строки этот ответ уничтожает.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { deactivateAlert } from '@/lib/safety/alerts';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Неверный идентификатор' }, { status: 400 });
  }

  try {
    const removed = await deactivateAlert(id);
    // «Не нашли» и «сняли» — разные ответы: первое означает, что кто-то уже
    // снял его раньше или идентификатор чужой, и молчать об этом нельзя.
    if (!removed) {
      return NextResponse.json(
        { success: false, error: 'Действующее предупреждение с таким идентификатором не найдено' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[safety-alerts] снятие не выполнено:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Предупреждение не снято' }, { status: 500 });
  }
}
