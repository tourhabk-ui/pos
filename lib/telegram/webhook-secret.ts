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
 *
 * Что делать с 'not_configured' — решает не вызывающий, а `refuseUnconfiguredWebhook`
 * ниже: отказ, одинаковый у всех обработчиков (аудит 15.10, P3-03).
 */

import { NextResponse } from 'next/server';
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

/**
 * Ответ обработчика на исход 'not_configured': отказ 503 и строка в лог.
 *
 * До аудита 15.10 (находка P3-03) все три Telegram-обработчика при незаданном
 * секрете писали в лог и ПРОДОЛЖАЛИ работу. Адрес `/api/telegram/*` публичен на
 * Edge намеренно, значит секрет — единственная дверь, и без него открыто всё,
 * что обработчик делает по `from.id` из тела: в главном вебхуке это админ-ветка
 * (/diag отдавал начала ключей, /migrate, /agent, /post, кнопки лида), и ответ
 * уходил в `chat.id` из того же тела. Защита исчезала ровно тогда, когда её
 * забыли настроить, — та же форма, что у reposter (tests/unit/webhook-secrets).
 *
 * Прежний довод за работу без секрета — «бот замолчит до правки окружения»
 * (#1168) — проверен замером с прода 15.10: живой вебхук один,
 * /api/telegram/webhook, его секрет задан (POST без заголовка → 403); роуты
 * admin и kuzmich вебхуком не зарегистрированы (бот один, его адрес держит
 * telegram-webhook-watchdog). Отказ не глушит ни одного живого бота, а
 * незаданный секрет теперь виден: обработчик отвечает 503, сторож вебхука
 * пишет владельцу (lib/telegram/operator-availability).
 *
 * 503, а не 401/403: «не настроено» — про нас, а не про того, кто стучится.
 *
 * @param route   имя обработчика для лога, например 'telegram/webhook'
 * @param envName имя переменной окружения с секретом (имя, не значение)
 */
export function refuseUnconfiguredWebhook(route: string, envName: string): NextResponse {
  console.error(`[${route}] ${envName} не задан — запрос отклонён: без секрета подлинность webhook не проверить`);
  return NextResponse.json(
    { ok: false, error: `Приём не настроен: нет ${envName}` },
    { status: 503 },
  );
}
