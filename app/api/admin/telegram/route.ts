/**
 * GET  /api/admin/telegram — статус бота и webhook
 * POST /api/admin/telegram — сохранить токен, зарегистрировать webhook (всё через сервер)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getSetting, setSetting } from '@/lib/platform-settings';

const APP_URL      = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vedarai.ru';
const WEBHOOK_PATH = '/api/telegram/kuzmich';

async function resolveToken(): Promise<string> {
  return (
    process.env.TELEGRAM_KUZMICH_BOT_TOKEN ??
    process.env.TELEGRAM_BOT_TOKEN ??
    (await getSetting('telegram_bot_token')) ??
    ''
  );
}

type TgResponse<T> = { ok: boolean; result?: T; description?: string };

async function tgCall<T>(token: string, method: string, body?: unknown): Promise<TgResponse<T>> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return res.json() as Promise<TgResponse<T>>;
}

export async function GET(request: NextRequest) {
  const adminOrErr = await requireAdmin(request);
  if (adminOrErr instanceof NextResponse) return adminOrErr;

  const token = await resolveToken();
  if (!token) return NextResponse.json({ configured: false, token_source: null });

  const source = process.env.TELEGRAM_KUZMICH_BOT_TOKEN
    ? 'env:TELEGRAM_KUZMICH_BOT_TOKEN'
    : process.env.TELEGRAM_BOT_TOKEN
      ? 'env:TELEGRAM_BOT_TOKEN'
      : 'db:platform_settings';

  let webhook = null;
  try {
    const data = await tgCall<{ url: string; pending_update_count: number; last_error_message?: string }>(token, 'getWebhookInfo');
    if (data.ok) webhook = data.result ?? null;
  } catch { /* сервер не достучался до Telegram */ }

  return NextResponse.json({ configured: true, token_source: source, token_tail: token.slice(-6), webhook });
}

export async function POST(request: NextRequest) {
  const adminOrErr = await requireAdmin(request);
  if (adminOrErr instanceof NextResponse) return adminOrErr;

  const body = await request.json() as { token?: string; reregister?: boolean };

  const token = body.token?.trim() || (body.reregister ? await resolveToken() : '');
  if (!token) return NextResponse.json({ success: false, error: 'Токен не указан и не задан в env' }, { status: 400 });

  // Проверяем токен
  let me: { username: string; first_name: string } | undefined;
  try {
    const meData = await tgCall<{ username: string; first_name: string }>(token, 'getMe');
    if (!meData.ok) {
      return NextResponse.json({ success: false, error: `Неверный токен: ${meData.description ?? 'ошибка Telegram'}` }, { status: 400 });
    }
    me = meData.result;
  } catch (err) {
    return NextResponse.json({ success: false, error: `Сервер не достучался до Telegram: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  // Регистрируем webhook
  const webhookUrl = `${APP_URL}${WEBHOOK_PATH}`;
  try {
    const whData = await tgCall(token, 'setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    if (!whData.ok) {
      return NextResponse.json({ success: false, error: `Webhook не зарегистрирован: ${whData.description}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: `Ошибка регистрации webhook: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  // Сохраняем токен в БД если передан явно (не из env)
  if (body.token?.trim()) {
    try { await setSetting('telegram_bot_token', token); } catch { /* не критично */ }
  }

  return NextResponse.json({ success: true, bot: me, webhook_url: webhookUrl });
}
