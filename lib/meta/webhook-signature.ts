/**
 * lib/meta/webhook-signature.ts
 *
 * Подлинность вебхука Meta: Instagram, Messenger (`/api/meta/webhook`) и
 * WhatsApp Business (`/api/whatsapp/kuzmich`).
 *
 * Meta подписывает каждое уведомление: заголовок X-Hub-Signature-256 —
 * "sha256=" и HMAC-SHA256 от сырого тела на секрете приложения. Только эта
 * подпись отличает Meta от любого, кто знает адрес: отправитель, его имя и
 * текст приходят в теле от того, кто стучится.
 *
 * До 07.11 оба приёмника подпись не проверяли, хотя `.env.example` обещал
 * META_APP_SECRET «для валидации X-Hub-Signature-256», а WhatsApp — в
 * комментарии «optional but recommended». Объявление без исполнения (§10.09):
 * подделка вела Кузьмича от чужого имени и тратила модели на наши ключи. На
 * проде оба адреса закрыты Edge — их нет в реестре публичных API, POST без
 * входа отвечает 401 (замер 07.11), так что подделка туда не доходила.
 * Проверка нужна, чтобы открытие адреса не открыло и Кузьмича.
 *
 * Три исхода, как у Telegram (lib/telegram/webhook-secret): секрета нет — это
 * 'not_configured', а не «проверка пройдена». Отказ на него — общий
 * `refuseUnconfiguredWebhook`, 503.
 */

import { createHmac } from 'node:crypto';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import type { SecretVerdict } from '@/lib/telegram/webhook-secret';

/** Заголовок подписи Meta (имена заголовков без учёта регистра). */
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Имя переменной окружения с секретом приложения Meta — имя, не значение. */
export const META_APP_SECRET_ENV = 'META_APP_SECRET';

/**
 * Подпись тела: HMAC считается по байтам, как они пришли, — до разбора JSON.
 * Пересобранный JSON дал бы другие байты и другую подпись.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | null,
  appSecret: string | undefined,
): SecretVerdict {
  if (!appSecret) return 'not_configured';
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return timingSafeCompare(header, expected) ? 'ok' : 'forbidden';
}

/**
 * Рукопожатие GET при подписке: Meta присылает hub.verify_token, мы отвечаем
 * hub.challenge, только если токен наш. Сверка — постоянным временем; токен
 * не задан — рукопожатия нет.
 */
export function metaHandshakeOk(
  mode: string | null,
  token: string | null,
  challenge: string | null,
  expected: string | undefined,
): boolean {
  if (mode !== 'subscribe' || !challenge || !expected) return false;
  return timingSafeCompare(token, expected);
}
