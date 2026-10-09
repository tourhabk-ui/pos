/**
 * GET  /api/hub/crm/tasks?status=open|done&contact_id= — задачи партнёра
 * POST /api/hub/crm/tasks                              — новая задача
 *
 * CRM фаза 1, шаг 1в (#2325). Та же дверь шести ролей, что у клиентов:
 * чей партнёр — решает requirePartner, скоуп `partner_id` стоит в каждом SQL.
 * Задача о чужом клиенте отвечает 404, как о несуществующем.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { createTask, listTasks } from '@/lib/crm/tasks';
import { DETAILS_MAX, TITLE_MAX } from '@/lib/crm/event-kinds';

export const dynamic = 'force-dynamic';

const ListQuery = z.object({
  status: z.enum(['open', 'done']).default('open'),
  contact_id: z.string().uuid().optional(),
});

/** Срок в прошлом допустим: «перезвонить вчера» заводят, когда вспомнили. */
export const NewTaskSchema = z.object({
  title: z.string().trim().min(1, 'Напишите, что сделать').max(TITLE_MAX),
  details: z.string().max(DETAILS_MAX).optional().nullable(),
  due_at: z.string().datetime({ offset: true, message: 'Укажите срок' }),
  contact_id: z.string().uuid().optional().nullable(),
});

function failed(err: unknown, what: string, message: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[crm] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: message }, { status: 503 });
}

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const parsed = ListQuery.safeParse({
    status: sp.get('status') ?? undefined,
    contact_id: sp.get('contact_id') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры' }, { status: 400 });
  }
  try {
    const items = await listTasks(ctx.partnerId, {
      status: parsed.data.status,
      contactId: parsed.data.contact_id ?? null,
    });
    return NextResponse.json({ success: true, data: { items, status: parsed.data.status } });
  } catch (err) {
    return failed(err, 'задачи не прочитаны', 'Не удалось загрузить задачи, попробуйте позже');
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = NewTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  try {
    const r = await createTask(ctx.partnerId, {
      title: parsed.data.title,
      details: parsed.data.details ?? null,
      dueAt: new Date(parsed.data.due_at),
      contactId: parsed.data.contact_id ?? null,
      createdBy: ctx.userId,
    });
    if (r.outcome === 'contact_not_found') {
      return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: r.task }, { status: 201 });
  } catch (err) {
    return failed(err, 'задача не заведена', 'Не удалось сохранить задачу, попробуйте позже');
  }
}
