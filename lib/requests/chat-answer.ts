/** Запись ответа кнопкой; кнопки и разбор — chat-answer-buttons (без базы). */

import { pool } from '@/lib/db-pool';
import type { ChatAnswer, ChatAnswerKind } from '@/lib/requests/chat-answer-buttons';

export * from '@/lib/requests/chat-answer-buttons';

export async function recordChatAnswer(opts: {
  partnerId: string;
  kind: ChatAnswerKind;
  subjectId: string;
  answer: ChatAnswer;
}): Promise<{ ok: true; already: boolean } | { ok: false }> {
  try {
    const inserted = await pool.query(
      `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (subject_kind, subject_id) DO NOTHING
       RETURNING id`,
      [opts.partnerId, opts.kind, opts.subjectId, opts.answer],
    );
    return { ok: true, already: (inserted.rowCount ?? 0) === 0 };
  } catch (err) {
    console.error('[chat-answer] ответ не записан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { ok: false };
  }
}
