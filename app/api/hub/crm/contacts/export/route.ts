/**
 * GET /api/hub/crm/contacts/export?q=&tag=&segment= — клиенты партнёра в CSV
 * (CRM #2325, шаг 1а-2b).
 *
 * Те же клиенты и фильтры, что на экране «Клиенты»; скоуп `partner_id` — в
 * SQL, как у списка. У оператора в выгрузке ещё суммы броней и сегмент.
 * Больше `EXPORT_MAX_ROWS` — отказ со словами, а не молча обрезанный файл:
 * обрезанная выгрузка читается как «вот все мои клиенты».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { listContacts } from '@/lib/crm/contact-queries';
import { listOperatorClients } from '@/lib/crm/operator-clients';
import { OPERATOR_SEGMENTS } from '@/lib/crm/operator-segments';
import { contactsToCsv, EXPORT_MAX_ROWS, type ExportItem } from '@/lib/crm/contacts-export';

export const dynamic = 'force-dynamic';

const ExportQuery = z.object({
  q: z.string().max(100).optional(),
  tag: z.string().max(40).optional(),
  segment: z.enum(OPERATOR_SEGMENTS).optional(),
});

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const parsed = ExportQuery.safeParse({
    q: sp.get('q') ?? undefined,
    tag: sp.get('tag') ?? undefined,
    segment: sp.get('segment') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры выгрузки' }, { status: 400 });
  }
  const { q, tag, segment } = parsed.data;
  const isOperator = ctx.category === 'operator';
  if (!isOperator && segment) {
    return NextResponse.json(
      { success: false, error: 'Сегменты есть только у клиентов оператора' },
      { status: 400 },
    );
  }

  let items: ExportItem[];
  let total: number;
  try {
    // На одну строку больше предела — чтобы отличить «ровно предел» от «больше».
    const r = isOperator
      ? await listOperatorClients(ctx.partnerId, { q, tag, segment, sort: 'recent', limit: EXPORT_MAX_ROWS + 1, offset: 0 })
      : await listContacts(ctx.partnerId, { q, tag, limit: EXPORT_MAX_ROWS + 1, offset: 0 });
    items = r.items;
    total = r.total;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] выгрузка клиентов не прочитана, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось выгрузить клиентов, попробуйте позже' }, { status: 503 });
  }

  if (total > EXPORT_MAX_ROWS) {
    return NextResponse.json(
      {
        success: false,
        error: `Клиентов по запросу ${total} — больше ${EXPORT_MAX_ROWS} за одну выгрузку. Сузьте поиском или меткой.`,
      },
      { status: 413 },
    );
  }

  const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kamchatka' });
  return new NextResponse(contactsToCsv(items, isOperator), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="clients-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
