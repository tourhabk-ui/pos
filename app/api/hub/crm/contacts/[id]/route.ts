/**
 * GET   /api/hub/crm/contacts/[id] — карточка клиента: контакты, согласие,
 *                                   источники (брони, заявки) с датами
 * PATCH /api/hub/crm/contacts/[id] — имя, заметка, метки
 *
 * CRM фаза 1, шаг 1а (#2325). Скоуп партнёра — в SQL: чужая карточка
 * отвечает 404, как несуществующая.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { getContactCard, updateContact } from '@/lib/crm/contact-queries';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Id = z.string().uuid();

export const ContactPatchSchema = z
  .object({
    display_name: z.string().trim().min(1, 'Имя не может быть пустым').max(200).optional(),
    notes: z.string().max(5000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Нечего сохранять');

function failed(err: unknown, what: string, message: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[crm] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: message }, { status: 503 });
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
  }
  try {
    const card = await getContactCard(ctx.partnerId, id);
    if (!card) return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    return NextResponse.json({ success: true, data: card });
  } catch (err) {
    return failed(err, 'карточка клиента не прочитана', 'Не удалось открыть клиента, попробуйте позже');
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
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
  const parsed = ContactPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  try {
    const ok = await updateContact(ctx.partnerId, id, parsed.data);
    if (!ok) return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return failed(err, 'клиент не сохранён', 'Не удалось сохранить клиента, попробуйте позже');
  }
}
