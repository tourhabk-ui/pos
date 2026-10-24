/**
 * /api/admin/telegram-link — Telegram администратора (слово владельца 24.10:
 * «нет привязки админа к Telegram»).
 *
 *   GET    — подключён ли Telegram у вошедшего администратора;
 *   POST   — одноразовая ссылка на 10 минут: открыть в Telegram и нажать «Старт»;
 *   DELETE — отключить.
 *
 * AUTH: requireAdmin — и до любого запроса к базе. Имя бота берётся у самого
 * бота (getMe). Если его не спросили — ссылка всё равно выдаётся по запасному
 * имени, а ответ называет источник: «не проверено» не равно «это точное имя».
 *
 * Ссылка в ответе — ключ: ответ не кешируется, и в лог ключ не пишется.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { resolveTelegramBotUsername } from '@/lib/telegram/bot-username';
import { adminTelegramStatus, issueAdminTelegramLink, unbindAdminTelegram } from '@/lib/telegram/admin-link';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function failed(what: string, err: unknown): NextResponse {
  const e = err as { code?: string };
  console.error(`[admin/telegram-link] ${what}, SQLSTATE`, e?.code ?? 'нет SQLSTATE');
  return NextResponse.json(
    { success: false, error: 'База не ответила, попробуйте позже' },
    { status: 500, headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const status = await adminTelegramStatus(auth.userId);
    return NextResponse.json(
      { success: true, data: { bound: status.bound, bound_at: status.boundAt } },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failed('состояние не прочитано', err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const bot = await resolveTelegramBotUsername();
    const res = await issueAdminTelegramLink(auth.userId, bot.name);
    if (!res.ok) {
      const error = res.reason === 'bot_name'
        ? 'Имя бота не получено, ссылку не собрал'
        : 'У аккаунта больше нет роли администратора';
      return NextResponse.json(
        { success: false, error },
        { status: res.reason === 'bot_name' ? 500 : 403, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      {
        success: true,
        data: {
          link: res.link,
          expires_at: res.expiresAt.toISOString(),
          bot_source: bot.source,
          bot_reason: bot.reason,
        },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failed('ссылка не выдана', err);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const was = await unbindAdminTelegram(auth.userId);
    return NextResponse.json({ success: true, data: { unbound: was } }, { headers: NO_STORE });
  } catch (err) {
    return failed('Telegram не отключён', err);
  }
}
