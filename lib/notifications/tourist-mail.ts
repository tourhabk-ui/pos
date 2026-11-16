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
 *
 * Тревога при этом не теряется (#3433 п. 4, слово владельца 16.11 «Тревога
 * надёжно»): факт «письмо по брони не ушло» записывается в
 * `tourist_mail_failures` (1450) без ПД. Повтор, который дошёл, или тревога,
 * которая дошла, закрывают строку. Не закрытую за 15 минут — процесс
 * перезапустился — называет Watchdog (`checkUndeliveredTouristMail`).
 */
import { emailService } from '@/lib/notifications/email-service';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';
import { redactPII } from '@/lib/security/pii-redact';
import { getPublicBaseUrl } from '@/lib/config';
import { pool } from '@/lib/db-pool';

export const RETRY_DELAY_MS = 5 * 60_000;

/**
 * Письма, которые не ушли и которые никто не закрыл за 15 минут: повтор и
 * тревога жили в памяти и пропали с перезапуском. Окно — сутки: старше —
 * тревога уже была. Читает Watchdog (checkUndeliveredTouristMail). Без ПД.
 */
export const TOURIST_MAIL_STUCK_SQL = `
  SELECT COUNT(*)::text AS count,
         string_agg(booking_id, ', ' ORDER BY failed_at) AS ids
    FROM tourist_mail_failures
   WHERE resolved_at IS NULL
     AND failed_at < now() - interval '15 minutes'
     AND failed_at > now() - interval '24 hours'`;

export type TouristMailOutcome = 'sent' | 'retrying';

export interface TouristMail {
  to: string;
  subject: string;
  html: string;
}

/**
 * Одна попытка. Не бросает ни при каком ответе: вызывающие зовут отправку
 * через `void`, и брошенное здесь стало бы необработанным отказом процесса.
 *
 * Текст отказа SMTP часто называет получателя («550 <ivan@mail.ru>: user
 * unknown»), а дальше он идёт в лог и в Telegram владельцу. Адрес туриста
 * для разбора не нужен — бронь называет номер, — поэтому причина чистится
 * redactPII здесь, в единственном месте, где она рождается (аудит 15.10, Д4-5).
 */
async function attempt(mail: TouristMail): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await emailService.sendEmail(mail);
    if (r && r.success) return { ok: true };
    return { ok: false, error: redactPII(r?.error ?? 'почтовый сервис не ответил') };
  } catch (err) {
    return { ok: false, error: redactPII(err instanceof Error ? err.message : String(err)) };
  }
}

export async function sendTouristMail(
  scope: string,
  bookingId: string | number,
  mail: TouristMail,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<TouristMailOutcome> {
  const first = await attempt(mail);
  if (first.ok) return 'sent';

  console.error(`[${scope}] письмо туристу не ушло, повтор через ${Math.round(retryDelayMs / 1000)} с:`,
    `booking=${bookingId}`, first.error);
  const failureId = await recordFailure(scope, bookingId);

  const timer = setTimeout(() => {
    void (async () => {
      const second = await attempt(mail);
      if (second.ok) {
        await resolveFailure(scope, failureId, 'sent');
        return;
      }
      console.error(`[${scope}] письмо туристу не ушло и со второй попытки:`,
        `booking=${bookingId}`, second.error);
      const out = await tgSend(scope, [
        '<b>Письмо туристу не ушло дважды</b>',
        '',
        `Бронирование: #${escapeHtml(String(bookingId))}`,
        `Письмо: ${escapeHtml(mail.subject)}`,
        `Причина: ${escapeHtml(second.error)}`,
        '',
        'Турист не получил ссылку на свою бронь. Передайте её вручную:',
        `${getPublicBaseUrl()}/hub/admin/bookings`,
      ].join('\n'));
      if (!out.ok) {
        // Строка остаётся открытой — тревогу повторит Watchdog.
        console.error(`[${scope}] тревога владельцу не ушла:`, out.reason);
        return;
      }
      await resolveFailure(scope, failureId, 'alerted');
    })();
  }, retryDelayMs);
  // Повтор не держит процесс живым (и тесты — открытыми).
  timer.unref?.();

  return 'retrying';
}

/**
 * Факт недоставки — в базу. Отказ базы не роняет отправку: повтор в памяти
 * идёт как раньше, отказ называется в логе.
 */
async function recordFailure(scope: string, bookingId: string | number): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tourist_mail_failures (booking_id, scope) VALUES ($1, $2) RETURNING id::text AS id`,
      [String(bookingId), scope.slice(0, 64)],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'нет кода';
    console.error(`[${scope}] факт недоставки письма не записан (${code}) — при перезапуске тревоги не будет`);
    return null;
  }
}

async function resolveFailure(scope: string, id: string | null, resolution: 'sent' | 'alerted'): Promise<void> {
  if (!id) return;
  try {
    await pool.query(
      `UPDATE tourist_mail_failures SET resolved_at = now(), resolution = $2 WHERE id = $1::bigint AND resolved_at IS NULL`,
      [id, resolution],
    );
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'нет кода';
    console.error(`[${scope}] отметка письма не записана (${code}) — Watchdog может прислать лишнюю тревогу`);
  }
}
