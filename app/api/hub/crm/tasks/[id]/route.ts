/**
 * PATCH  /api/hub/crm/tasks/[id] — `{ action: 'done' }` отмечает выполненной
 *                                 (с клиентом — событие в ленте), иначе
 *                                 правка заголовка, подробностей, срока
 * DELETE /api/hub/crm/tasks/[id] — удалить ошибочно заведённую
 *
 * CRM фаза 1, шаг 1в (#2325). Чужая задача отвечает 404, как несуществующая;
 * выполненная не правится и повторно не отмечается — тоже 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { completeTask, deleteTask, updateTask } from '@/lib/crm/tasks';
import { DETAILS_MAX, TITLE_MAX } from '@/lib/crm/event-kinds';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Id = z.string().uuid();

export const TaskPatchSchema = z.union([
  z.object({ action: z.literal('done') }).strict(),
  z
    .object({
      title: z.string().trim().min(1, 'Заголовок не может быть пустым').max(TITLE_MAX).optional(),
      details: z.string().max(DETAILS_MAX).nullable().optional(),
      due_at: z.string().datetime({ offset: true, message: 'Укажите срок' }).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'Нечего сохранять'),
]);

const NOT_FOUND = { success: false, error: 'Задача не найдена или уже выполнена' } as const;

function failed(err: unknown, what: string, message: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[crm] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: message }, { status: 503 });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  if (!Id.safeParse(id).success) return NextResponse.json(NOT_FOUND, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = TaskPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const patch = parsed.data;
  try {
    if ('action' in patch) {
      const r = await completeTask(ctx.partnerId, id, ctx.userId);
      if (r.outcome === 'not_found') return NextResponse.json(NOT_FOUND, { status: 404 });
      return NextResponse.json({ success: true, data: r.task });
    }
    const task = await updateTask(ctx.partnerId, id, {
      title: patch.title,
      details: patch.details,
      dueAt: patch.due_at ? new Date(patch.due_at) : undefined,
    });
    if (!task) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ success: true, data: task });
  } catch (err) {
    return failed(err, 'задача не сохранена', 'Не удалось сохранить задачу, попробуйте позже');
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const gone = { success: false, error: 'Задача не найдена' } as const;
  if (!Id.safeParse(id).success) return NextResponse.json(gone, { status: 404 });
  try {
    const ok = await deleteTask(ctx.partnerId, id);
    if (!ok) return NextResponse.json(gone, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return failed(err, 'задача не удалена', 'Не удалось удалить задачу, попробуйте позже');
  }
}
