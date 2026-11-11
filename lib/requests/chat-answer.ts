/** Запись ответа кнопкой; кнопки и разбор — chat-answer-buttons (без базы). */

import { pool } from '@/lib/db-pool';
import { LEAD_ANSWER_DATE_SQL } from '@/lib/requests/answer-date';
import type { ChatAnswer, ChatAnswerKind, DeclineReason } from '@/lib/requests/chat-answer-buttons';

export * from '@/lib/requests/chat-answer-buttons';

/** Дата заявки, на которую отвечают (1422), — строгий ISO или NULL. */
export const LEAD_ANSWER_DATE_READ_SQL = `
  SELECT ${LEAD_ANSWER_DATE_SQL('l')} AS d FROM leads l WHERE l.id::text = $1::text`;

/**
 * Ответ и дата заявки — одной командой. Дата берётся из самой заявки в момент
 * записи; `$6` — проверять ли её против `$7` (дата, которую оператор видел в
 * вопросе). Не совпала — строки нет, и ответ не записан: он был о дате,
 * которой в заявке уже нет. ON CONFLICT без цели — уникальность (предмет,
 * партнёр, дата) 1422: второй ответ того же партнёра на ту же дату — «уже».
 */
export const CHAT_ANSWER_INSERT_SQL = `
  WITH lead AS (
    SELECT ${LEAD_ANSWER_DATE_SQL('l')} AS d
      FROM leads l
     WHERE $2::text = 'lead' AND l.id::text = $3::text
  ), ins AS (
    INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer, decline_reason, subject_date)
    SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, (SELECT d FROM lead)
     WHERE NOT $6::boolean OR (SELECT d FROM lead) IS NOT DISTINCT FROM $7::text
    ON CONFLICT DO NOTHING
    RETURNING id
  )
  SELECT (SELECT id::text FROM ins) AS answer_id, (SELECT d FROM lead) AS subject_date`;

export type ChatAnswerRecord =
  | { ok: true; already: boolean; dateChanged: false; subjectDate: string | null }
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
    const { rows: [row] } = await pool.query<{ answer_id: string | null; subject_date: string | null }>(
      CHAT_ANSWER_INSERT_SQL,
      [
        opts.partnerId, opts.kind, opts.subjectId, opts.answer,
        opts.answer === 'decline' ? (opts.reason ?? 'other') : null,
        check, check ? opts.expectDate ?? null : null,
      ],
    );
    const subjectDate = row?.subject_date ?? null;
    if (row?.answer_id) return { ok: true, already: false, dateChanged: false, subjectDate };
    if (check && subjectDate !== (opts.expectDate ?? null)) return { ok: true, already: false, dateChanged: true, subjectDate };
    return { ok: true, already: true, dateChanged: false, subjectDate };
  } catch (err) {
    console.error('[chat-answer] ответ не записан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { ok: false };
  }
}
