/**
 * Письмо с данными выезда для МЧС — отправка и журнал (mchs_letters, 1415).
 * Что письмо есть и чем не является, получатель и слова — lib/safety/mchs-letter-text.
 */

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

export const MCHS_LETTER_LAST_SQL = `
  SELECT created_at::text AS at,
         (created_at > NOW() - make_interval(secs => $4::int)) AS recent
    FROM mchs_letters
   WHERE partner_id = $1::uuid AND operator_tour_id = $2::bigint AND departure_date = $3::date
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

/** Последнее принятое почтой письмо по выезду. null — не было; 'failed' — журнал не прочитался. */
export async function lastMchsLetter(
  partnerId: string, tourId: string, date: string, db: Queryable = pool,
): Promise<MchsLastLetter | null | 'failed'> {
  try {
    const { rows } = await db.query<{ at: string; recent: boolean }>(
      MCHS_LETTER_LAST_SQL, [partnerId, tourId, date, Math.round(MCHS_LETTER_REPEAT_MS / 1000)],
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
