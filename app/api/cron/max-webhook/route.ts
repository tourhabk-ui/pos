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

import { maxFetch } from '@/lib/max/max-fetch';
import { NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { maxWebhookUrl, redactWebhookUrl } from '@/lib/max/webhook-url';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

// MAX Bot API v2 — старый platform-api.max.ru выведен из эксплуатации.
const MAX_API_BASE = 'https://platform-api2.max.ru';
const UPDATE_TYPES = ['bot_started', 'message_created', 'message_callback'];

interface MaxSubscription { url?: string }

/**
 * Причина сетевого отказа. 223 прогона подряд писали только «fetch failed», и
 * что это сертификат, а не сеть, выяснилось лишь чтением цепочки руками.
 */
function causeOf(err: unknown): string | null {
  const c = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
  if (!c) return null;
  const code = typeof c === 'object' && c !== null && 'code' in c ? String((c as { code: unknown }).code) : '';
  const msg = c instanceof Error ? c.message : String(c);
  return [code, msg].filter(Boolean).join(': ').slice(0, 200);
}

// URL с webhook-секретом (если задан MAX_WEBHOOK_SECRET) — см. lib/max/webhook-url.
function expectedWebhookUrl(): string {
  return maxWebhookUrl();
}

/**
 * Снять НАШИ старые подписки: тот же адрес /api/max/kuzmich, но не тот, что
 * ждём (обычно — без секрета, заведённый до MAX_WEBHOOK_SECRET). Без этого MAX
 * шлёт каждое сообщение на оба адреса: человек получает два ответа, а
 * незаверенная копия идёт мимо проверки источника. Чужие адреса не трогаем.
 * Зовётся только когда ожидаемый адрес уже точно зарегистрирован — иначе
 * бот остался бы без подписки вовсе.
 */
async function removeStale(
  current: MaxSubscription[],
  webhookUrl: string,
  headers: Record<string, string>,
): Promise<{ removed: string[]; failed: string[] }> {
  const ours = webhookUrl.split('?')[0];
  const stale = current
    .map((s) => s.url ?? '')
    .filter((u) => u !== webhookUrl && u.split('?')[0] === ours);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const url of stale) {
    try {
      const res = await maxFetch(`${MAX_API_BASE}/subscriptions?url=${encodeURIComponent(url)}`, { method: 'DELETE', headers });
      (res.ok ? removed : failed).push(redactWebhookUrl(url));
    } catch {
      failed.push(redactWebhookUrl(url));
    }
  }
  return { removed, failed };
}

export async function GET(req: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req) ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Отметка прогона в agent_run_history под ключом реестра 'max-webhook'
  // (аудит 15.10, P4-07). Крон был немым: бот в MAX однажды уже молчал месяц
  // без сигнала, а «перестал запускаться» сам сторож подписки не видел никто.
  // Каждый ответ после проверки секрета проходит через finish: 200 — успех,
  // всё прочее — отказ с причиной. Адрес вебхука в причину не попадает — в
  // нём секрет.
  const t0 = Date.now();
  const finish = (body: Record<string, unknown>, status = 200): NextResponse => {
    if (status === 200) {
      recordCronRun('max-webhook', t0, 'success');
    } else {
      const staleFailed = Array.isArray(body.stale_failed) ? body.stale_failed.length : 0;
      const why = [
        body.step, body.action, body.error, body.cause, body.status,
        staleFailed > 0 ? `не сняты старые подписки: ${staleFailed}` : undefined,
      ]
        .filter((x) => x !== undefined && x !== null && x !== '')
        .map(String)
        .join(': ');
      recordCronRun('max-webhook', t0, 'failed', { error: (why || `HTTP ${status}`).slice(0, 300) });
    }
    return NextResponse.json(body, { status });
  };

  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    return finish({ error: 'MAX_BOT_TOKEN not set' }, 500);
  }

  const headers = { 'Content-Type': 'application/json', Authorization: token };
  const webhookUrl = expectedWebhookUrl();

  // 1. Что сейчас зарегистрировано в MAX
  let current: MaxSubscription[] = [];
  let listOk = false;
  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, { method: 'GET', headers });
    listOk = res.ok;
    const data = await res.json().catch(() => ({}));
    // MAX может вернуть { subscriptions: [...] } или массив
    const raw = Array.isArray(data) ? data : (data?.subscriptions ?? []);
    if (Array.isArray(raw)) current = raw as MaxSubscription[];
  } catch (err) {
    return finish(
      { ok: false, step: 'list', error: err instanceof Error ? err.message : 'fetch failed', cause: causeOf(err) },
      502,
    );
  }

  const alreadyRegistered = current.some(s => s.url === webhookUrl);

  // 2. Уже на месте — ничего не трогаем
  if (alreadyRegistered) {
    const stale = await removeStale(current, webhookUrl, headers);
    return finish({
      ok: stale.failed.length === 0,
      action: stale.removed.length > 0 ? 'removed_stale' : 'noop',
      webhook_url: redactWebhookUrl(webhookUrl),
      subscriptions: current.length,
      stale_removed: stale.removed,
      stale_failed: stale.failed,
    }, stale.failed.length === 0 ? 200 : 502);
  }

  // 3. Подписки нет — регистрируем заново (самолечение)
  let registerStatus = 0;
  let registerResponse: unknown = null;
  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: webhookUrl, update_types: UPDATE_TYPES }),
    });
    registerStatus = res.status;
    registerResponse = await res.json().catch(() => ({}));
    if (!res.ok) {
      return finish(
        { ok: false, action: 'register_failed', status: registerStatus, webhook_url: redactWebhookUrl(webhookUrl), response: registerResponse },
        502,
      );
    }
  } catch (err) {
    return finish(
      { ok: false, step: 'register', error: err instanceof Error ? err.message : 'fetch failed', cause: causeOf(err) },
      502,
    );
  }

  const stale = await removeStale(current, webhookUrl, headers);
  return finish({
    ok: stale.failed.length === 0,
    stale_removed: stale.removed,
    stale_failed: stale.failed,
    action: 'registered',
    reason: listOk ? 'subscription_missing' : 'list_unavailable',
    webhook_url: redactWebhookUrl(webhookUrl),
    update_types: UPDATE_TYPES,
    register_status: registerStatus,
    response: registerResponse,
  }, stale.failed.length === 0 ? 200 : 502);
}
