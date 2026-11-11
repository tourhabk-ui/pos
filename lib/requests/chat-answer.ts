/** Запись ответа кнопкой; кнопки и разбор — chat-answer-buttons (без базы). */

import { pool } from '@/lib/db-pool';
import { LEAD_ANSWER_DATE_SQL } from '@/lib/requests/answer-date';
import type { ChatAnswer, ChatAnswerKind, DeclineReason } from '@/lib/requests/chat-answer-buttons';

export * from '@/lib/requests/chat-answer-buttons';

/** Дата заявки, на которую отвечают (1422), — строгий ISO или NULL. */
export const LEAD_ANSWER_DATE_READ_SQL = `
  SELECT ${LEAD_ANSWER_DATE_SQL('l')} AS d FROM leads l WHERE l.id::text = $1::text`;

/** Ответы, о которых сообщаем человеку (план «после отказа», 2б, 1423). */
export const NOTICE_ANSWERS = ['no_seats', 'decline', 'other_date'] as const;

/**
 * Ответ, дата заявки и запись «что сообщить человеку» — одной командой.
 *
 * Дата берётся из самой заявки в момент записи; `$6` — проверять ли её против
 * `$7` (дата, которую оператор видел в вопросе). Не совпала — строки нет, и
 * ответ не записан: он был о дате, которой в заявке уже нет. ON CONFLICT без
 * цели — уникальность (предмет, партнёр, дата) 1422: второй ответ того же
 * партнёра на ту же дату — «уже».
 *
 * Запись о сообщении (`answer_notices`, 1423) рождается только от ответа,
 * который вставила эта команда, и только на «Нет мест», «Отказать», «Другая
 * дата»: повтор нажатия второго сообщения не даёт. Сразу «пропущено», если
 * заявка не этого партнёра (ничейную занял кабинет), своя проба или уже
 * закрыта (`lost`/`converted` до ответа: «Потерян» → «Отказать» не скажет
 * человеку «оператор отказал» по закрытой заявке). Иначе — «ждёт» с захватом
 * на 5 минут: отправляет нажатие, добивка берёт строку только после захвата.
 */
export const CHAT_ANSWER_INSERT_SQL = `
  WITH lead AS (
    SELECT l.id, l.status, l.operator_id, l.is_self, ${LEAD_ANSWER_DATE_SQL('l')} AS d
      FROM leads l
     WHERE $2::text = 'lead' AND l.id::text = $3::text
  ), ins AS (
    INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer, decline_reason, subject_date)
    SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, (SELECT d FROM lead)
     WHERE NOT $6::boolean OR (SELECT d FROM lead) IS NOT DISTINCT FROM $7::text
    ON CONFLICT DO NOTHING
    RETURNING id
  ), note AS (
    INSERT INTO answer_notices (lead_id, answer_id, answer, decline_reason, lead_status_before,
                                state, skipped_reason, claimed_until, decided_at)
    SELECT lead.id, ins.id, $4::text, $5::text, lead.status,
           CASE WHEN s.skip IS NULL THEN 'pending' ELSE 'skipped' END, s.skip,
           CASE WHEN s.skip IS NULL THEN NOW() + INTERVAL '5 minutes' END,
           CASE WHEN s.skip IS NOT NULL THEN NOW() END
      FROM ins CROSS JOIN lead
     CROSS JOIN LATERAL (
       SELECT CASE WHEN lead.operator_id IS DISTINCT FROM $1::uuid THEN 'not_addressee'
                   WHEN lead.is_self THEN 'self'
                   WHEN lead.status IN ('lost', 'converted') THEN 'lead_closed' END AS skip
     ) s
     WHERE $4::text IN (${NOTICE_ANSWERS.map((a) => `'${a}'`).join(', ')})
    RETURNING id, state, skipped_reason
  )
  SELECT (SELECT id::text FROM ins) AS answer_id, (SELECT d FROM lead) AS subject_date,
         (SELECT id::text FROM note) AS notice_id, (SELECT state FROM note) AS notice_state,
         (SELECT skipped_reason FROM note) AS notice_skip`;

/** Запись о сообщении человеку, рождённая этим ответом; null — ответ не из тех, о которых сообщаем. */
export interface NewNotice { id: string; state: 'pending' | 'skipped'; skipped: string | null }

export type ChatAnswerRecord =
  | { ok: true; already: boolean; dateChanged: false; subjectDate: string | null; notice?: NewNotice | null }
  /** Дата заявки сменилась после вопроса: ответ не записан, `subjectDate` — дата сейчас. */
  | { ok: true; already: false; dateChanged: true; subjectDate: string | null }
  | { ok: false };

/** Дата заявки сейчас: строгий ISO, null — даты нет; 'failed' — не прочиталась. */
export async function readLeadAnswerDate(leadId: string): Promise<string | null | 'failed'> {
  try {
    const { rows: [row] } = await pool.query<{ d: string | null }>(LEAD_ANSWER_DATE_READ_SQL, [leadId]);
    return row?.d ?? null;
  } catch (err) {
    console.error('[chat-answer] дата заявки не прочиталась, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'failed';
  }
}

export async function recordChatAnswer(opts: {
  partnerId: string;
  kind: ChatAnswerKind;
  subjectId: string;
  answer: ChatAnswer;
  /** Только для `decline`: причина кнопкой (миграция 1367). */
  reason?: DeclineReason | null;
  /**
   * Дата заявки, которую оператор видел в вопросе (хвост кнопки, 1422).
   * undefined — не проверять (не заявка). null — «у заявки даты не было».
   */
  expectDate?: string | null;
}): Promise<ChatAnswerRecord> {
  const check = opts.kind === 'lead' && opts.expectDate !== undefined;
  try {
    const { rows: [row] } = await pool.query<{
      answer_id: string | null; subject_date: string | null;
      notice_id: string | null; notice_state: 'pending' | 'skipped' | null; notice_skip: string | null;
    }>(
      CHAT_ANSWER_INSERT_SQL,
      [
        opts.partnerId, opts.kind, opts.subjectId, opts.answer,
        opts.answer === 'decline' ? (opts.reason ?? 'other') : null,
        check, check ? opts.expectDate ?? null : null,
      ],
    );
    const subjectDate = row?.subject_date ?? null;
    if (row?.answer_id) {
      const notice = row.notice_id && row.notice_state ? { id: row.notice_id, state: row.notice_state, skipped: row.notice_skip } : null;
      return { ok: true, already: false, dateChanged: false, subjectDate, notice };
    }
    if (check && subjectDate !== (opts.expectDate ?? null)) return { ok: true, already: false, dateChanged: true, subjectDate };
    return { ok: true, already: true, dateChanged: false, subjectDate };
  } catch (err) {
    console.error('[chat-answer] ответ не записан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { ok: false };
  }
}
