/**
 * Письмо с данными выезда для МЧС — отправка и журнал (mchs_letters, 1415).
 * Что письмо есть и чем не является, получатель и слова — lib/safety/mchs-letter-text.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { emailService } from '@/lib/notifications/email-service';
import { redactPII } from '@/lib/security/pii-redact';
import type { MchsGroup } from '@/lib/safety/mchs-chat';
import {
  MCHS_LETTER, MCHS_LETTER_REPEAT_MS, mchsLetterHtml, mchsLetterSubject,
  type MchsLetterOutcome, type MchsLetterSender,
} from '@/lib/safety/mchs-letter-text';

/** Отказ почты — без адресов и телефонов: причина идёт в журнал и в чат. */
function cleanError(raw: string | undefined): string {
  return redactPII(raw ?? 'почтовый сервис не ответил').slice(0, 300);
}

/**
 * Отправить письмо. Не бросает: исход — значением. «Не настроено» отделено от
 * «не ушло»: первое чинится в панели приложения, второе — у почтового сервера.
 */
export async function sendMchsLetter(
  g: MchsGroup, sender: MchsLetterSender, nowMs: number,
): Promise<{ outcome: MchsLetterOutcome; error: string | null }> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return { outcome: 'not_configured', error: null };
  try {
    const r = await emailService.sendEmail({
      to: MCHS_LETTER.to, subject: mchsLetterSubject(g), html: mchsLetterHtml(g, sender, nowMs),
    });
    return r.success ? { outcome: 'sent', error: null } : { outcome: 'failed', error: cleanError(r.error) };
  } catch (err) {
    return { outcome: 'failed', error: cleanError(err instanceof Error ? err.message : String(err)) };
  }
}

// ── Журнал (mchs_letters, 1415) ─────────────────────────────────────────────

interface Queryable {
  query: typeof pool.query;
}

function logFail(what: string, err: unknown): void {
  console.error(`[mchs-letter] ${what} — отказ, SQLSTATE ${(err as { code?: string } | null)?.code ?? 'нет SQLSTATE'}`);
}

/**
 * Последнее письмо по ВЫЕЗДУ, а не по карточке (10.11). Выезд один на тур и
 * дату, а нажать могут и туроператор, и гид этого выезда: при отборе по
 * partner_id каждый слал своё, и в ящик приходило два письма об одной группе.
 */
export const MCHS_LETTER_LAST_SQL = `
  SELECT created_at::text AS at,
         (created_at > NOW() - make_interval(secs => $3::int)) AS recent
    FROM mchs_letters
   WHERE operator_tour_id = $1::bigint AND departure_date = $2::date
     AND outcome = 'sent'
   ORDER BY created_at DESC
   LIMIT 1`;

export const MCHS_LETTER_INSERT_SQL = `
  INSERT INTO mchs_letters (partner_id, operator_tour_id, departure_date, channel, sent_to, is_test, outcome, error, people, bookings)
  VALUES ($1::uuid, $2::bigint, $3::date, $4, $5, $6, $7, $8, $9, $10)`;

export interface MchsLastLetter {
  /** Момент отправки строкой базы. */
  at: string;
  /** Отправлено меньше MCHS_LETTER_REPEAT_MS назад. */
  recent: boolean;
}

/**
 * Последнее принятое почтой письмо по выезду, кто бы его ни отправил.
 * null — не было; 'failed' — журнал не прочитался.
 */
export async function lastMchsLetter(
  tourId: string, date: string, db: Queryable = pool,
): Promise<MchsLastLetter | null | 'failed'> {
  try {
    const { rows } = await db.query<{ at: string; recent: boolean }>(
      MCHS_LETTER_LAST_SQL, [tourId, date, Math.round(MCHS_LETTER_REPEAT_MS / 1000)],
    );
    return rows[0] ? { at: rows[0].at, recent: rows[0].recent === true } : null;
  } catch (err) {
    logFail('чтение журнала писем', err);
    return 'failed';
  }
}

/** Запись исхода. false — журнал не записался (письмо при этом могло уйти). */
export async function recordMchsLetter(
  e: { sender: MchsLetterSender; group: MchsGroup; outcome: MchsLetterOutcome; error: string | null },
  db: Queryable = pool,
): Promise<boolean> {
  try {
    await db.query(MCHS_LETTER_INSERT_SQL, [
      e.sender.partnerId, e.group.tourId, e.group.date, e.sender.channel, MCHS_LETTER.to, MCHS_LETTER.test,
      e.outcome, e.error, e.group.people, e.group.bookings,
    ]);
    return true;
  } catch (err) {
    logFail('запись в журнал писем', err);
    return false;
  }
}

// ── Замок выезда ────────────────────────────────────────────────────────────

/**
 * Проверка «письма за десять минут не было» и запись исхода — два запроса, а
 * между ними уходит письмо. Два нажатия подряд (двойной тап, повтор вебхука,
 * оператор и гид одновременно) оба проходили проверку до первой записи и слали
 * по письму (аудит 10.11). Замок сериализует их по выезду: второй ждёт не
 * письма, а честного ответа «уже отправляется».
 *
 * Сессионный advisory-замок держится на одном соединении от проверки до
 * записи. Не снялся — соединение уничтожается, а не возвращается в пул: иначе
 * замок прожил бы на нём до перезапуска и запер выезд навсегда.
 */
export const MCHS_LETTER_LOCK_SQL =
  `SELECT pg_try_advisory_lock(hashtext('mchs_letter'), hashtext($1::text || ':' || $2::text)) AS got`;
export const MCHS_LETTER_UNLOCK_SQL =
  `SELECT pg_advisory_unlock(hashtext('mchs_letter'), hashtext($1::text || ':' || $2::text)) AS released`;

/**
 * Выполнить `fn` под замком выезда. 'busy' — по этому выезду письмо уже
 * отправляется; 'failed' — замок не удалось взять или проверить (база), и
 * `fn` не вызывалась.
 */
export async function withMchsLetterLock<T>(
  tourId: string, date: string, fn: () => Promise<T>,
): Promise<T | 'busy' | 'failed'> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logFail('замок выезда: соединение', err);
    return 'failed';
  }
  let got: boolean;
  try {
    const { rows } = await client.query<{ got: boolean }>(MCHS_LETTER_LOCK_SQL, [tourId, date]);
    got = rows[0]?.got === true;
  } catch (err) {
    logFail('замок выезда', err);
    client.release();
    return 'failed';
  }
  if (!got) {
    client.release();
    return 'busy';
  }
  let broken = false;
  try {
    return await fn();
  } finally {
    try {
      await client.query(MCHS_LETTER_UNLOCK_SQL, [tourId, date]);
    } catch (err) {
      broken = true;
      logFail('снятие замка выезда', err);
    }
    client.release(broken);
  }
}
