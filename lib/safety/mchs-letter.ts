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
  type MchsLetterOutcome, type MchsLetterSender, type MchsSentLetter,
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

/** Пул или одно соединение: под замком выезда журнал идёт на соединении замка. */
export interface MchsLetterDb {
  query: typeof pool.query;
}

function logFail(what: string, err: unknown): void {
  console.error(`[mchs-letter] ${what} — отказ, SQLSTATE ${(err as { code?: string } | null)?.code ?? 'нет SQLSTATE'}`);
}

/**
 * Принятые почтой письма по ВЫЕЗДУ — от всех карточек (10.11). Выезд один на
 * тур и дату, а нажать могут и владелец тура, и гид его команды: при отборе по
 * partner_id каждый слал своё, и в ящик приходило два письма об одной группе.
 *
 * Но состав письма — по карточке (lib/chat-cabinet/mchs-store, OWN_OR_ASSIGNED):
 * владелец тура видит все брони выезда, гид команды — только назначенные ему.
 * Поэтому журнал отдаёт не «письмо было», а чьё оно и сколько в нём людей:
 * письмо гида о двух людях не должно выдаваться оператору за письмо о пяти
 * (ревью PR 3188). `whole` — письмо отправила карточка-владелец тура, в нём
 * все брони выезда; `sender_whole` — тот же вопрос о том, кто спрашивает.
 */
export const MCHS_LETTERS_SENT_SQL = `
  SELECT l.created_at::text AS at,
         (l.created_at > NOW() - make_interval(secs => $3::int)) AS recent,
         (l.partner_id = $4::uuid) AS mine,
         EXISTS (SELECT 1 FROM operator_tours t
                  WHERE t.id = l.operator_tour_id AND t.operator_id = l.partner_id) AS whole,
         EXISTS (SELECT 1 FROM operator_tours t
                  WHERE t.id = l.operator_tour_id AND t.operator_id = $4::uuid) AS sender_whole,
         l.people, l.bookings
    FROM mchs_letters l
   WHERE l.operator_tour_id = $1::bigint AND l.departure_date = $2::date
     AND l.outcome = 'sent'
   ORDER BY l.created_at DESC
   LIMIT 20`;

export const MCHS_LETTER_INSERT_SQL = `
  INSERT INTO mchs_letters (partner_id, operator_tour_id, departure_date, channel, sent_to, is_test, outcome, error, people, bookings)
  VALUES ($1::uuid, $2::bigint, $3::date, $4, $5, $6, $7, $8, $9, $10)`;

export interface MchsSentLetters {
  /** Принятые почтой письма по выезду, свежие первыми. */
  letters: MchsSentLetter[];
  /** Спрашивает карточка-владелец тура: её письмо несло бы все брони выезда. */
  senderWhole: boolean;
}

interface SentRow {
  at: string; recent: boolean; mine: boolean; whole: boolean; sender_whole: boolean;
  people: number | string; bookings: number | string;
}

/**
 * Письма по выезду глазами карточки `partnerId`, кто бы их ни отправил.
 * 'failed' — журнал не прочитался. Что из этого запрещает повтор, решает
 * `blockingMchsLetter` (lib/safety/mchs-letter-text), не запрос.
 */
export async function sentMchsLetters(
  tourId: string, date: string, partnerId: string, db: MchsLetterDb = pool,
): Promise<MchsSentLetters | 'failed'> {
  try {
    const { rows } = await db.query<SentRow>(
      MCHS_LETTERS_SENT_SQL, [tourId, date, Math.round(MCHS_LETTER_REPEAT_MS / 1000), partnerId],
    );
    return {
      letters: rows.map((r) => ({
        at: r.at, recent: r.recent === true, mine: r.mine === true, whole: r.whole === true,
        people: Number(r.people), bookings: Number(r.bookings),
      })),
      senderWhole: rows[0]?.sender_whole === true,
    };
  } catch (err) {
    logFail('чтение журнала писем', err);
    return 'failed';
  }
}

/** Запись исхода. false — журнал не записался (письмо при этом могло уйти). */
export async function recordMchsLetter(
  e: { sender: MchsLetterSender; group: MchsGroup; outcome: MchsLetterOutcome; error: string | null },
  db: MchsLetterDb = pool,
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
 * Ключ — номер тура и дата в том виде, в каком их сравнивает журнал
 * (bigint и date): иначе «81» и «000000081» дали бы разные замки при одной
 * строке журнала, и замок обходился бы другим написанием номера (ревью PR 3188).
 *
 * Сессионный advisory-замок держится на одном соединении от проверки до
 * записи. Это же соединение получает `fn` — журнал читается и пишется на нём:
 * первая редакция брала для журнала второе соединение пула, и каждое нажатие
 * занимало два на всё время разговора с почтовым сервером (ревью PR 3188).
 * Не снялся замок — соединение уничтожается, а не возвращается в пул: иначе
 * замок прожил бы на нём до перезапуска и запер выезд навсегда.
 */
export const MCHS_LETTER_LOCK_SQL =
  `SELECT pg_try_advisory_lock(hashtext('mchs_letter'), hashtext($1::bigint::text || ':' || $2::date::text)) AS got`;
export const MCHS_LETTER_UNLOCK_SQL =
  `SELECT pg_advisory_unlock(hashtext('mchs_letter'), hashtext($1::bigint::text || ':' || $2::date::text)) AS released`;

/**
 * Выполнить `fn` под замком выезда, на соединении замка. 'busy' — по этому
 * выезду письмо уже отправляется; 'failed' — замок не удалось взять или
 * проверить (база), и `fn` не вызывалась.
 */
export async function withMchsLetterLock<T>(
  tourId: string, date: string, fn: (db: MchsLetterDb) => Promise<T>,
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
    return await fn(client);
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
