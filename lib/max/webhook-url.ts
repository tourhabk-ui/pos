/**
 * lib/max/webhook-url.ts
 *
 * Единая точка построения и ПРОВЕРКИ webhook-URL бота MAX.
 *
 * Проблема: POST /api/max/kuzmich публичный и не проверяет источник — форжнутый
 * bot_started с чужим max_user_id даёт захват аккаунта через вход по MAX
 * (security-ревью #961, HIGH). Telegram решает это HMAC-подписью; у MAX своего
 * секрета вебхука мы подтвердить не смогли, поэтому кладём секрет В САМ URL
 * подписки: MAX зовёт РОВНО тот URL, что мы зарегистрировали, а атакующий
 * секрета не знает. Сверяем константно.
 *
 * Fail-closed: нет MAX_WEBHOOK_SECRET → вход через MAX не подтверждается вообще.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';

function base(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://vedarai.ru').replace(/\/$/, '');
}

/** URL для регистрации подписки. С секретом — если он задан. */
export function maxWebhookUrl(): string {
  const url = `${base()}/api/max/kuzmich`;
  const secret = process.env.MAX_WEBHOOK_SECRET;
  return secret ? `${url}?s=${encodeURIComponent(secret)}` : url;
}

/**
 * URL для показа в ответах/логах: секрет замаскирован. Ответ крона печатается
 * в лог GitHub Actions — сырой URL слил бы webhook-секрет наружу.
 */
export function redactWebhookUrl(url: string): string {
  return url.replace(/([?&]s=)[^&]+/, '$1[secret]');
}

/**
 * Заверен ли входящий webhook-запрос как пришедший от MAX (по секрету в URL).
 * Нет секрета в окружении → false (fail-closed): подтверждать вход нельзя.
 */
export function isVerifiedMaxWebhook(requestUrl: string): boolean {
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (!secret) return false;
  let provided: string | null = null;
  try { provided = new URL(requestUrl).searchParams.get('s'); } catch { provided = null; }
  return timingSafeCompare(provided ?? '', secret);
}
