/**
 * GET /api/hub/crm/inbox — «Входящие» партнёра: что ждёт ответа, сколько
 * ждёт, и медиана первого ответа за 7 дней (CRM #2325, шаг 1г).
 *
 * Кто вошёл и чей он партнёр — решает requirePartner, скоуп `partner_id`
 * стоит в каждом SQL. Не прочитался один вид — ответ 200 со списком
 * `failed`: остальное партнёр видит, а экран говорит, чего не хватает. Не
 * прочиталось ничего — 503, а не пустой ящик: «нечего отвечать» и «не смогли
 * проверить» — разные ответы (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartner } from '@/lib/crm/partner-context';
import { loadInbox } from '@/lib/crm/inbox';
import { INBOX_BY_CATEGORY } from '@/lib/crm/inbox-kinds';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const inbox = await loadInbox(ctx.partnerId, ctx.category, ctx.userId);
    const kinds = INBOX_BY_CATEGORY[ctx.category];
    if (kinds.length > 0 && inbox.failed.length === kinds.length) {
      return NextResponse.json(
        { success: false, error: 'Не удалось загрузить входящие, попробуйте позже' },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: true, data: inbox });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] входящие не прочитаны, SQLSTATE', code);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить входящие, попробуйте позже' },
      { status: 503 },
    );
  }
}
