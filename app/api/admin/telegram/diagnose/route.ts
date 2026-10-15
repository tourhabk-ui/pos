/**
 * GET /api/admin/telegram/diagnose
 * Диагностика + авто-фикс: getWebhookInfo → если адрес не главный → setCanonicalWebhook
 * (главный адрес с секретом, аудит 15.10; прежде ставился /api/telegram/kuzmich без секрета).
 * Возвращает полный JSON для копирования.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getSetting } from '@/lib/platform-settings';
import { canonicalWebhookUrl, setCanonicalWebhook } from '@/lib/telegram/operator-availability';

async function resolveToken(): Promise<string> {
  return (
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
    return NextResponse.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан в Timeweb' });
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

  // 1. Кто мы?
  const me = await tg('getMe').catch((e: unknown) => ({ ok: false, error: String(e) }));

  // 2. Текущий webhook
  const info = await tg('getWebhookInfo').catch((e: unknown) => ({ ok: false, error: String(e) }));

  const webhookUrl = canonicalWebhookUrl();
  const currentUrl = (info as { result?: { url?: string } })?.result?.url ?? '';
  const needsFix   = currentUrl !== webhookUrl;

  const setResult = needsFix ? await setCanonicalWebhook(token) : null;

  // 3. Повторный getWebhookInfo после фикса
  const infoAfter = needsFix
    ? await tg('getWebhookInfo').catch((e: unknown) => ({ ok: false, error: String(e) }))
    : info;

  return NextResponse.json({
    token_tail:      token.slice(-6),
    token_source:    process.env.TELEGRAM_BOT_TOKEN ? 'env:TELEGRAM_BOT_TOKEN' : 'db:platform_settings',
    me,
    expected_url:    webhookUrl,
    webhook_before:  info,
    webhook_fixed:   needsFix,
    set_webhook:     setResult,
    webhook_after:   infoAfter,
  }, { status: 200 });
}
