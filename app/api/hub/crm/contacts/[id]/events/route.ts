/**
 * POST /api/hub/crm/contacts/[id]/events — касание руками партнёра: заметка,
 * звонок, встреча (CRM фаза 1, шаг 1б, #2325).
 *
 * Та же функция, что зовут Кузьмич партнёра и MCP партнёра (addContactTouch);
 * роут — лишь дверь экрана. Чужой клиент отвечает 404, как несуществующий.
 * Смены статуса и сообщения чата сюда не приходят — их пишут производители
 * в самих источниках.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { addContactTouch } from '@/lib/crm/events';
import { DETAILS_MAX, TITLE_MAX, TOUCH_KINDS } from '@/lib/crm/event-kinds';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Id = z.string().uuid();

/** Задним числом — можно (звонок был утром); вперёд — нет: это задача, а не событие. */
const TouchSchema = z.object({
  kind: z.enum(TOUCH_KINDS),
  title: z.string().trim().min(1, 'Напишите, что произошло').max(TITLE_MAX),
  details: z.string().max(DETAILS_MAX).optional().nullable(),
  occurred_at: z.string().datetime({ offset: true }).optional()
    .refine((v) => v === undefined || new Date(v).getTime() <= Date.now() + 5 * 60_000, 'Событие не может быть в будущем — для этого есть задачи'),
});

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = TouchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  try {
    const r = await addContactTouch(ctx.partnerId, id, {
      kind: parsed.data.kind,
      title: parsed.data.title,
      details: parsed.data.details ?? null,
      actorKind: 'partner_user',
      actorUserId: ctx.userId,
      occurredAt: parsed.data.occurred_at ? new Date(parsed.data.occurred_at) : null,
    });
    if (r.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: { id: r.id } }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] касание не записано, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось записать, попробуйте позже' }, { status: 503 });
  }
}
