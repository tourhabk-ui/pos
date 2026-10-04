/**
 * lib/notifications/tourist-mail.ts — письмо туристу о его брони, которое
 * нельзя потерять молча.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Гостю ссылка на оплату приходит только письмом (lib/bookings/guest-contact):
 * письмо о подтверждении — единственный путь от «оператор подтвердил» к
 * оплате. До 04.10 оба письма брони отправлялись как
 * `sendEmail(...).catch(() => {})`, а `emailService.sendEmail` не бросает
 * вовсе — отказ приходит значением `{ success: false }`. То есть отказ SMTP
 * не видел никто: ни лог, ни оператор, ни владелец.
 *
 * ── Что делает ─────────────────────────────────────────────────────────────
 *
 * Отправляет; не ушло — строка в лог с номером брони и причиной, и одна
 * повторная попытка через RETRY_DELAY_MS. Не ушло и второй раз — тревога
 * владельцу в Telegram: ссылку передают руками.
 *
 * Повтор живёт в памяти процесса: перезапуск сервера в эти пять минут его
 * отменит. Это осознанно не очередь — первая строка лога остаётся в любом
 * случае, а вызывающий получает исход 'retrying' и говорит оператору, что
 * письмо не ушло.
 */
import { emailService } from '@/lib/notifications/email-service';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';
import { getPublicBaseUrl } from '@/lib/config';

export const RETRY_DELAY_MS = 5 * 60_000;

export type TouristMailOutcome = 'sent' | 'retrying';

export interface TouristMail {
  to: string;
  subject: string;
  html: string;
}

export async function sendTouristMail(
  scope: string,
  bookingId: string | number,
  mail: TouristMail,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<TouristMailOutcome> {
  const first = await emailService.sendEmail(mail);
  if (first.success) return 'sent';

  console.error(`[${scope}] письмо туристу не ушло, повтор через ${Math.round(retryDelayMs / 1000)} с:`,
    `booking=${bookingId}`, first.error ?? 'причина не названа');

  const timer = setTimeout(() => {
    void (async () => {
      const second = await emailService.sendEmail(mail);
      if (second.success) return;
      console.error(`[${scope}] письмо туристу не ушло и со второй попытки:`,
        `booking=${bookingId}`, second.error ?? 'причина не названа');
      const out = await tgSend(scope, [
        '<b>Письмо туристу не ушло дважды</b>',
        '',
        `Бронирование: #${escapeHtml(String(bookingId))}`,
        `Письмо: ${escapeHtml(mail.subject)}`,
        `Причина: ${escapeHtml(second.error ?? 'не названа')}`,
        '',
        'Турист не получил ссылку на свою бронь. Передайте её вручную:',
        `${getPublicBaseUrl()}/hub/admin/bookings`,
      ].join('\n'));
      if (!out.ok) console.error(`[${scope}] тревога владельцу не ушла:`, out.reason);
    })();
  }, retryDelayMs);
  // Повтор не держит процесс живым (и тесты — открытыми).
  timer.unref?.();

  return 'retrying';
}
