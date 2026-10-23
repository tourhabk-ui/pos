/**
 * lib/seat-requests/answer-edit.ts — после ответа оператора на запрос мест в
 * MAX бот правит само сообщение запроса (пилот «Камчатская рыбалка», 23.10):
 * «✓ Ответ дан: …», кнопки «Есть места / Мест нет» убраны — повторно на слабой
 * связи их не нажать. Взамен две кнопки типа `message` (шлют свой текст боту):
 * «Сводка» и «Следующая заявка».
 *
 * MAX: сообщение с inline-клавиатурой в диалоге правится без срока
 * (https://dev.max.ru/docs-api/methods/PUT/messages). Правка не удалась —
 * вызывающий шлёт ответ отдельным сообщением, как раньше.
 *
 * Флаг тот же, что у /сводки (summaryEnabledFor). Без ПД туриста.
 */
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { answerPayload } from '@/lib/seat-requests/core';

/** Лимит текста сообщения MAX (POST/PUT /messages). */
const MAX_TEXT = 4000;

export const SUMMARY_BUTTON_TEXT = 'Сводка';
export const NEXT_BUTTON_TEXT = 'Следующая заявка';

export type AfterAnswerButton = { type: 'message'; text: string };

/** Кнопки под отвеченным запросом. */
export function afterAnswerButtons(): AfterAnswerButton[][] {
  return [[{ type: 'message', text: SUMMARY_BUTTON_TEXT }, { type: 'message', text: NEXT_BUTTON_TEXT }]];
}

/**
 * Текст правки: исходный текст запроса (приходит без разметки — экранируется)
 * и строка «✓ Ответ дан: …». `replyHtml` — уже HTML (operatorReplyText).
 */
export function answeredEditText(originalText: string | null | undefined, replyHtml: string): string {
  const tail = `\n\n✓ Ответ дан: ${replyHtml}`;
  const head = escapeHtml((originalText ?? '').trim());
  if (!head) return tail.trim();
  const room = MAX_TEXT - tail.length;
  return (head.length > room ? head.slice(0, Math.max(0, room - 1)) + '…' : head) + tail;
}

/** «Следующая заявка», «/следующая», «/next» — вся фраза, регистр не важен. */
export function isNextCommand(text: string): boolean {
  return /^\/?(следующая(\s+заявка)?|next)[.!]?$/i.test(text.trim());
}

export interface NextPending {
  id: string;
  title: string;
  tourDate: string;
  participants: number;
  deadlineAt: Date;
}

/** Ожидающий запрос с ближайшим сроком. null — нет, 'db_error' — база не ответила. */
export async function readNextPending(partnerId: string): Promise<NextPending | null | 'db_error'> {
  try {
    const { rows } = await pool.query<{ id: string; title: string; tour_date: string; participants: number; deadline_at: Date }>(
      `SELECT r.id, t.title, r.tour_date::text AS tour_date, r.participants, r.deadline_at
         FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
        WHERE r.operator_id = $1 AND r.status = 'pending' AND r.answered_at IS NULL AND r.deadline_at > NOW()
        ORDER BY r.deadline_at ASC LIMIT 1`,
      [partnerId],
    );
    const r = rows[0];
    return r ? { id: r.id, title: r.title, tourDate: r.tour_date, participants: r.participants, deadlineAt: new Date(r.deadline_at) } : null;
  } catch (err) {
    console.error('[seat-answer-edit] следующая заявка не прочитана, SQLSTATE', (err as { code?: string })?.code ?? 'нет SQLSTATE');
    return 'db_error';
  }
}

export const NEXT_NONE = 'Ожидающих запросов нет.';
export const NEXT_DB_ERROR = 'Следующую заявку сейчас не достать — база не ответила. Попробуйте через минуту.';

export type CardButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string };

/** Карточка запроса — те же текст и кнопки, что в первом сообщении (service.ts). */
export function nextRequestCard(r: NextPending, answerUrl: string | null): { text: string; buttons: CardButton[][] } {
  const deadlineLocal = r.deadlineAt.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Kamchatka', hour: '2-digit', minute: '2-digit' });
  const text = [
    '<b>Запрос мест</b>',
    `«${escapeHtml(r.title)}», ${r.tourDate}, ${r.participants} чел.`,
    `Ответ до ${deadlineLocal} (Камчатка). «Есть места» — бронь сразу.`,
  ].join('\n');
  const buttons: CardButton[][] = [[
    { type: 'callback', text: 'Есть места', payload: answerPayload('yes', r.id) },
    { type: 'callback', text: 'Мест нет', payload: answerPayload('no', r.id) },
  ]];
  if (answerUrl) buttons.push([{ type: 'link', text: 'Другая дата / ответить на сайте', url: answerUrl }]);
  return { text, buttons };
}
