/**
 * GET /api/cron/max-webhook  (Authorization: Bearer <CRON_SECRET> или ?secret=)
 *
 * Самолечение MAX-бота Кузьмича. Бот в MAX получает апдейты ТОЛЬКО через webhook-
 * подписку в MAX (POST /api/max/kuzmich). Если подписка теряется (смена домена,
 * вывод из эксплуатации старого хоста platform-api.max.ru, авто-снятие подписки
 * после серии ошибок) — бот молча замолкает и никто об этом не узнаёт.
 *
 * Этот крон детерминированно ПРОВЕРЯЕТ, что наш webhook-URL присутствует в списке
 * подписок MAX, и если его нет — регистрирует заново. Прогоняется по расписанию
 * (крон-воркфлоу) и вручную (workflow_dispatch), чтобы поднять бота немедленно.
 *
 * Идемпотентно: если подписка уже на месте — ничего не меняет.
 * Env: MAX_BOT_TOKEN, CRON_SECRET.
 */

import { NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { maxWebhookUrl, redactWebhookUrl } from '@/lib/max/webhook-url';

export const dynamic = 'force-dynamic';

// MAX Bot API v2 — старый platform-api.max.ru выведен из эксплуатации.
const MAX_API_BASE = 'https://platform-api2.max.ru';
const UPDATE_TYPES = ['bot_started', 'message_created', 'message_callback'];

interface MaxSubscription { url?: string }

// URL с webhook-секретом (если задан MAX_WEBHOOK_SECRET) — см. lib/max/webhook-url.
function expectedWebhookUrl(): string {
  return maxWebhookUrl();
}

export async function GET(req: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req) ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'MAX_BOT_TOKEN not set' }, { status: 500 });
  }

  const headers = { 'Content-Type': 'application/json', Authorization: token };
  const webhookUrl = expectedWebhookUrl();

  // 1. Что сейчас зарегистрировано в MAX
  let current: MaxSubscription[] = [];
  let listOk = false;
  try {
    const res = await fetch(`${MAX_API_BASE}/subscriptions`, { method: 'GET', headers });
    listOk = res.ok;
    const data = await res.json().catch(() => ({}));
    // MAX может вернуть { subscriptions: [...] } или массив
    const raw = Array.isArray(data) ? data : (data?.subscriptions ?? []);
    if (Array.isArray(raw)) current = raw as MaxSubscription[];
  } catch (err) {
    return NextResponse.json(
      { ok: false, step: 'list', error: err instanceof Error ? err.message : 'fetch failed' },
      { status: 502 },
    );
  }

  const alreadyRegistered = current.some(s => s.url === webhookUrl);

  // 2. Уже на месте — ничего не трогаем
  if (alreadyRegistered) {
    return NextResponse.json({
      ok: true,
      action: 'noop',
      webhook_url: redactWebhookUrl(webhookUrl),
      subscriptions: current.length,
    });
  }

  // 3. Подписки нет — регистрируем заново (самолечение)
  let registerStatus = 0;
  let registerResponse: unknown = null;
  try {
    const res = await fetch(`${MAX_API_BASE}/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: webhookUrl, update_types: UPDATE_TYPES }),
    });
    registerStatus = res.status;
    registerResponse = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, action: 'register_failed', status: registerStatus, webhook_url: redactWebhookUrl(webhookUrl), response: registerResponse },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, step: 'register', error: err instanceof Error ? err.message : 'fetch failed' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: 'registered',
    reason: listOk ? 'subscription_missing' : 'list_unavailable',
    webhook_url: redactWebhookUrl(webhookUrl),
    update_types: UPDATE_TYPES,
    register_status: registerStatus,
    response: registerResponse,
  });
}
