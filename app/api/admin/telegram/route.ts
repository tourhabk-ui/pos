/**
 * GET  /api/admin/telegram — текущий статус бота (webhook через браузер)
 * POST /api/admin/telegram — сохранить токен в БД
 *   { token, skip_telegram: true }  — только сохранить, без вызова Telegram API
 *   { reregister: true }            — вернуть токен клиенту для регистрации из браузера
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getSetting, setSetting } from '@/lib/platform-settings';

async function resolveToken(): Promise<string> {
  return (
    process.env.TELEGRAM_KUZMICH_BOT_TOKEN ??
    process.env.TELEGRAM_BOT_TOKEN ??
    (await getSetting('telegram_bot_token')) ??
    ''
  );
}

export async function GET(request: NextRequest) {
  const adminOrErr = await requireAdmin(request);
  if (adminOrErr instanceof NextResponse) return adminOrErr;

  const token = await resolveToken();
  if (!token) {
    return NextResponse.json({ configured: false, token_source: null });
  }

  const source = process.env.TELEGRAM_KUZMICH_BOT_TOKEN
    ? 'env:TELEGRAM_KUZMICH_BOT_TOKEN'
    : process.env.TELEGRAM_BOT_TOKEN
      ? 'env:TELEGRAM_BOT_TOKEN'
      : 'db:platform_settings';

  // Пробуем получить webhook info — может не работать если сервер не достучится до Telegram
  let webhook = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as { ok: boolean; result?: { url: string; pending_update_count: number; last_error_message?: string } };
      if (data.ok) webhook = data.result;
    }
  } catch { /* сервер не достучался до Telegram — ок, браузер проверит */ }

  return NextResponse.json({
    configured: true,
    token_source: source,
    token_tail: token.slice(-6),
    webhook,
  });
}

export async function POST(request: NextRequest) {
  const adminOrErr = await requireAdmin(request);
  if (adminOrErr instanceof NextResponse) return adminOrErr;

  const body = await request.json() as {
    token?: string;
    skip_telegram?: boolean;
    reregister?: boolean;
  };

  // Режим: вернуть токен клиенту для регистрации webhook из браузера
  if (body.reregister) {
    const token = await resolveToken();
    if (!token) return NextResponse.json({ success: false, error: 'Токен не задан' }, { status: 400 });
    return NextResponse.json({ success: true, token });
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ success: false, error: 'Токен не указан' }, { status: 400 });
  }

  // Сохраняем токен в БД
  try {
    await setSetting('telegram_bot_token', token);
  } catch (err) {
    return NextResponse.json({ success: false, error: `Ошибка БД: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
