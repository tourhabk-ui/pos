/**
 * GET  /api/admin/telegram — текущий статус бота
 * POST /api/admin/telegram — сохранить токен и зарегистрировать webhook
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getSetting, setSetting } from '@/lib/platform-settings';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vedarai.ru';
const WEBHOOK_PATH = '/api/telegram/kuzmich';

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

  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json() as { ok: boolean; result?: { url: string; pending_update_count: number; last_error_message?: string } };

  const source = process.env.TELEGRAM_KUZMICH_BOT_TOKEN
    ? 'env:TELEGRAM_KUZMICH_BOT_TOKEN'
    : process.env.TELEGRAM_BOT_TOKEN
      ? 'env:TELEGRAM_BOT_TOKEN'
      : 'db:platform_settings';

  return NextResponse.json({
    configured: true,
    token_source: source,
    token_tail: token.slice(-6),
    webhook: data.ok ? data.result : null,
  });
}

export async function POST(request: NextRequest) {
  const adminOrErr = await requireAdmin(request);
  if (adminOrErr instanceof NextResponse) return adminOrErr;

  const body = await request.json() as { token?: string };
  const token = body.token?.trim() || await resolveToken();

  if (!token) {
    return NextResponse.json({ success: false, error: 'Токен не указан' }, { status: 400 });
  }

  // Проверить токен
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meData = await meRes.json() as { ok: boolean; result?: { username: string; first_name: string }; description?: string };
  if (!meData.ok) {
    return NextResponse.json({ success: false, error: `Неверный токен: ${meData.description}` }, { status: 400 });
  }

  // Сохранить в БД
  await setSetting('telegram_bot_token', token);

  // Зарегистрировать webhook
  const webhookUrl = `${APP_URL}${WEBHOOK_PATH}`;
  const whRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  });
  const whData = await whRes.json() as { ok: boolean; description?: string };

  return NextResponse.json({
    success: whData.ok,
    bot: meData.result,
    webhook_url: webhookUrl,
    webhook_message: whData.description,
    error: whData.ok ? null : whData.description,
  });
}
