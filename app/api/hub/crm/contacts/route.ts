/**
 * GET  /api/hub/crm/contacts?q=&tag=&page=  — клиенты партнёра
 * POST /api/hub/crm/contacts                — клиент, заведённый руками
 *
 * CRM фаза 1, шаг 1а (#2325). Одна дверь на шесть ролей партнёров: кто
 * вошёл и чей он партнёр — решает requirePartner, скоуп `partner_id` стоит в
 * каждом SQL. Чужой контакт не находится.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { createManualContact, listContacts } from '@/lib/crm/contact-queries';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

const ListQuery = z.object({
  q: z.string().max(100).optional(),
  tag: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const Tag = z.string().trim().min(1).max(40);

export const ManualContactSchema = z.object({
  display_name: z.string().trim().min(1, 'Укажите имя').max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email('Почта не похожа на адрес').max(200).optional().nullable().or(z.literal('')),
  notes: z.string().max(5000).optional().nullable(),
  tags: z.array(Tag).max(20).optional(),
});

function failed(err: unknown, what: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[crm] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: 'Не удалось загрузить клиентов, попробуйте позже' }, { status: 503 });
}

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const parsed = ListQuery.safeParse({
    q: sp.get('q') ?? undefined,
    tag: sp.get('tag') ?? undefined,
    page: sp.get('page') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры поиска' }, { status: 400 });
  }
  const { q, tag, page } = parsed.data;

  try {
    const { items, total } = await listContacts(ctx.partnerId, {
      q, tag, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    });
    return NextResponse.json({
      success: true,
      data: { items, total, page, pageSize: PAGE_SIZE, category: ctx.category },
    });
  } catch (err) {
    return failed(err, 'список клиентов не прочитан');
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
  const parsed = ManualContactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  try {
    const r = await createManualContact(ctx.partnerId, {
      ...parsed.data,
      email: parsed.data.email || null,
    });
    if (r.outcome === 'bad_phone') {
      return NextResponse.json({ success: false, error: 'Телефон не похож на номер' }, { status: 400 });
    }
    if (r.outcome === 'exists') {
      return NextResponse.json(
        { success: false, error: 'Клиент с этим телефоном или почтой уже есть', data: { id: r.id } },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, data: { id: r.id } }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] клиент не заведён, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить клиента, попробуйте позже' }, { status: 503 });
  }
}
