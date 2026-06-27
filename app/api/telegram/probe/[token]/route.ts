/**
 * GET /api/telegram/probe/[token]
 * Публичный диагностический endpoint — токен бота является авторизацией.
 * Вызывает getWebhookInfo с сервера, авто-регистрирует webhook если пустой.
 */
import { NextRequest, NextResponse } from 'next/server';

const APP_URL      = (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net') ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru') : process.env.NEXT_PUBLIC_APP_URL) ?? 'https://vedarai.ru';
const WEBHOOK_PATH = '/api/telegram/kuzmich';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || !token.includes(':')) {
    return NextResponse.json({ ok: false, error: 'Токен не передан или неверный формат' }, { status: 400 });
  }

  const tg = async (method: string, body?: unknown) => {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return res.json();
  };

  // 1. Проверяем токен
  const me = await tg('getMe').catch((e: unknown) => ({ ok: false, error: String(e) }));
  if (!(me as { ok: boolean }).ok) {
    return NextResponse.json({ ok: false, step: 'getMe', result: me });
  }

  // 2. getWebhookInfo
  const before = await tg('getWebhookInfo').catch((e: unknown) => ({ ok: false, error: String(e) }));
  const currentUrl: string = (before as { result?: { url?: string } })?.result?.url ?? '';
  const webhookUrl = `${APP_URL}${WEBHOOK_PATH}`;
  const needsFix = !currentUrl || !currentUrl.includes('vedarai.ru');

  // 3. setWebhook если нужно
  let setResult = null;
  if (needsFix) {
    setResult = await tg('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }).catch((e: unknown) => ({ ok: false, error: String(e) }));
  }

  // 4. getWebhookInfo после фикса
  const after = needsFix
    ? await tg('getWebhookInfo').catch((e: unknown) => ({ ok: false, error: String(e) }))
    : before;

  return NextResponse.json({
    bot:            (me as { result?: { username: string; first_name: string } }).result,
    webhook_before: (before as { result?: unknown }).result,
    webhook_fixed:  needsFix,
    set_webhook:    setResult,
    webhook_after:  (after as { result?: unknown }).result,
  });
}
