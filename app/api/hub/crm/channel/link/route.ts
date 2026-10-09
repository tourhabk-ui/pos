/**
 * POST /api/hub/crm/channel/link — ссылки «подключить MAX / Telegram» для
 * СВОЕЙ карточки партнёра (решение владельца 09.10: «дай партнёру
 * возможность»). До этого MAX подключался только по ссылке администратора.
 *
 * Та же ссылка `op_`, что выдаёт администратор (`buildPartnerChannelLinks`):
 * подпись HMAC без запасного секрета, срок 72 часа, привязка через
 * `bindPartnerChannel` — о перепривязке узнают администратор и прежний чат.
 * Право назначить адрес проверено входом: id партнёра берётся из гарда, а
 * не из запроса — свою ссылку можно получить только на свою карточку.
 *
 * POST, а не GET: ответ — действующий ключ привязки, его не кэшируют.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartner } from '@/lib/crm/partner-context';
import { buildPartnerChannelLinks } from '@/lib/partners/channel-link';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  const links = buildPartnerChannelLinks(ctx.partnerId);
  if (!links.ok) {
    console.error('[crm/channel/link] ссылка не выдана:', links.reason);
    return NextResponse.json({ success: false, error: 'Подключение сейчас недоступно, попробуйте позже' }, { status: 503 });
  }
  return NextResponse.json(
    { success: true, data: { max: links.max, telegram: links.telegram, expires_at: links.expiresAt.toISOString() } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
