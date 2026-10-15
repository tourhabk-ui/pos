/**
 * Мессенджер МЕНЕДЖЕРА команды для уведомлений кабинета (CRM 2г-4).
 *
 *   GET    — подключён ли его MAX / Telegram (только «да/нет», без chat_id);
 *   POST   — ссылки «подключить» на его строку команды (`om_`, сутки);
 *   DELETE — отключить свой мессенджер.
 *
 * Строка команды берётся из гарда (operatorAccess → memberId), а не из
 * запроса: свою ссылку можно получить только на себя. Владелец кабинета здесь
 * ничего не подключает — его чат это чат кабинета (`/api/hub/crm/channel/link`,
 * баннер «Подключите MAX»): ответ 409 с подсказкой, куда идти.
 *
 * POST, а не GET: ответ — действующий ключ привязки, его не кэшируют.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperatorTeam } from '@/lib/operators/team-access';
import { buildMemberChannelLinks, unbindMemberChannel } from '@/lib/operators/member-channel';
import { resolveTelegramBotUsername } from '@/lib/telegram/bot-username';

export const dynamic = 'force-dynamic';

const OWNER_HINT = 'Ваш мессенджер подключается к кабинету — кнопкой «Подключите MAX» вверху кабинета';

export async function GET(request: NextRequest) {
  const ctx = await requireOperatorTeam(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.access.kind !== 'manager') {
    return NextResponse.json({ success: true, data: { kind: 'owner' } });
  }
  try {
    const { rows } = await pool.query<{ max: boolean; telegram: boolean }>(
      `SELECT (max_chat_id IS NOT NULL) AS max, (telegram_chat_id IS NOT NULL) AS telegram
         FROM operator_members WHERE id = $1::uuid`,
      [ctx.access.memberId],
    );
    const r = rows[0] ?? { max: false, telegram: false };
    return NextResponse.json({ success: true, data: { kind: 'manager', max: r.max, telegram: r.telegram } });
  } catch (err) {
    console.error('[operator/me/messenger] мессенджер менеджера не прочитан, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет');
    return NextResponse.json({ success: false, error: 'Не удалось проверить подключение — попробуйте позже' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireOperatorTeam(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.access.kind !== 'manager') {
    return NextResponse.json({ success: false, error: OWNER_HINT }, { status: 409 });
  }
  await resolveTelegramBotUsername(); // имя бота по getMe, не из переменной (15.10)
  const links = buildMemberChannelLinks(ctx.access.memberId);
  if (!links.ok) {
    console.error('[operator/me/messenger] ссылка менеджеру не выдана:', links.reason);
    return NextResponse.json({ success: false, error: 'Подключение сейчас недоступно, попробуйте позже' }, { status: 503 });
  }
  return NextResponse.json(
    { success: true, data: { max: links.max, telegram: links.telegram, expires_at: links.expiresAt.toISOString() } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireOperatorTeam(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.access.kind !== 'manager') {
    return NextResponse.json({ success: false, error: OWNER_HINT }, { status: 409 });
  }
  try {
    await unbindMemberChannel(ctx.access.memberId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[operator/me/messenger] мессенджер менеджера не отключён, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет');
    return NextResponse.json({ success: false, error: 'Не удалось отключить — попробуйте позже' }, { status: 503 });
  }
}
