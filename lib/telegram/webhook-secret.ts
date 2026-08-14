/**
 * lib/telegram/webhook-secret.ts
 *
 * Подлинность webhook-запроса Telegram.
 *
 * Telegram при регистрации webhook принимает `secret_token` и потом шлёт его
 * в заголовке `X-Telegram-Bot-Api-Secret-Token`. Это единственное, что в теле
 * запроса нельзя подделать: всё остальное — `message.from.id`, `message.chat.id`
 * — приходит от того, кто стучится, и доверять этому нельзя.
 *
 * Три исхода, а не два. «Секрет не задан» — это НЕ «проверка пройдена»:
 * настроенная защита и отсутствующая защита должны быть различимы вызывающим,
 * иначе незаведённая переменная окружения выглядит как успешная проверка. Ровно
 * та подмена незнания знанием, из-за которой мы весь день чинили мониторинг.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';

export type SecretVerdict = 'ok' | 'forbidden' | 'not_configured';

/**
 * @param given    значение заголовка X-Telegram-Bot-Api-Secret-Token
 * @param expected значение из окружения
 */
export function verifyWebhookSecret(
  given: string | null | undefined,
  expected: string | undefined,
): SecretVerdict {
  if (!expected) return 'not_configured';
  return timingSafeCompare(given, expected) ? 'ok' : 'forbidden';
}
