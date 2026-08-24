/**
 * lib/alice/webhook-url.ts
 *
 * Секрет в URL — по образцу lib/max/webhook-url.ts. Там это fail-closed
 * (вход по MAX через account linking, HIGH severity без него). Здесь риск
 * другого рода: навык только ЧИТАЕТ публичный список туров, ничего не пишет
 * и ни с чьим аккаунтом не связывается — эти данные и так открыты на сайте.
 * Поэтому секрет не блокирует, а просто отсекает случайный трафик не от
 * Алисы: нет ALICE_WEBHOOK_SECRET в окружении → проверка пропускается,
 * эндпоинт отвечает как есть.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';

function base(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://vedarai.ru').replace(/\/$/, '');
}

/** URL для поля Webhook URL в консоли dialogs.yandex.ru. С секретом — если он задан. */
export function aliceWebhookUrl(): string {
  const url = `${base()}/api/alice/webhook`;
  const secret = process.env.ALICE_WEBHOOK_SECRET;
  return secret ? `${url}?s=${encodeURIComponent(secret)}` : url;
}

/**
 * Заверен ли входящий запрос секретом в URL. Секрета в окружении нет →
 * true: проверять нечем, это не отказ (§4.0) — просто открытый эндпоинт.
 */
export function isVerifiedAliceWebhook(requestUrl: string): boolean {
  const secret = process.env.ALICE_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = new URL(requestUrl).searchParams.get('s') ?? '';
  return timingSafeCompare(provided, secret);
}

/** URL для показа в ответе /api/alice/setup: секрет замаскирован. */
export function redactAliceWebhookUrl(url: string): string {
  return url.replace(/([?&]s=)[^&]+/, '$1[secret]');
}
