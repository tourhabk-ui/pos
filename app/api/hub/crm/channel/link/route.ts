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
 * Канал карточки — настройка владельца (requirePartnerOwner, CRM 2г): менеджер
 * команды привязывал бы СВОЙ чат к адресу владельца, и заявки уходили бы ему.
 *
 * POST, а не GET: ответ — действующий ключ привязки, его не кэшируют.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartnerOwner } from '@/lib/crm/partner-context';
import { buildPartnerChannelLinks } from '@/lib/partners/channel-link';
import { resolveTelegramBotUsername } from '@/lib/telegram/bot-username';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ctx = await requirePartnerOwner(req);
  if (ctx instanceof NextResponse) return ctx;
  await resolveTelegramBotUsername(); // имя бота по getMe, не из переменной (15.10)
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
