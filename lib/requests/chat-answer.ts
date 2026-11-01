/**
 * Кнопки ответа на входящую заявку в чате оператора.
 * Нажатие записывает ответ и не подтверждает бронь и не открывает оплату.
 * Имени и телефона туриста в подписи кнопки нет.
 */

import { pool } from '@/lib/db-pool';
import type { InboxItem } from '@/lib/crm/inbox';
import type { InboxKind } from '@/lib/crm/inbox-kinds';

export const CHAT_ANSWER_KINDS = ['lead', 'stay_request', 'stay_booking', 'gear', 'booking'] as const;
export type ChatAnswerKind = (typeof CHAT_ANSWER_KINDS)[number];
export type ChatAnswer = 'accept' | 'other_date' | 'no_seats' | 'clarify' | 'self';

const KIND_CODE: Record<ChatAnswerKind, string> = {
  lead: 'l',
  stay_request: 'h',
  stay_booking: 's',
  gear: 'g',
  booking: 'b',
};
const CODE_KIND = new Map(Object.entries(KIND_CODE).map(([kind, code]) => [code, kind as ChatAnswerKind]));

const ANSWER_CODE: Record<ChatAnswer, string> = {
  accept: 'a',
  other_date: 'd',
  no_seats: 'n',
  clarify: 'c',
  self: 'm',
};
const CODE_ANSWER = new Map(Object.entries(ANSWER_CODE).map(([answer, code]) => [code, answer as ChatAnswer]));

const INBOX_KIND: Partial<Record<InboxKind, ChatAnswerKind>> = {
  operator_booking: 'booking',
  lead: 'lead',
  accommodation_booking: 'stay_booking',
  gear_rental: 'gear',
};

const ANSWER_LINE: Record<ChatAnswer, string> = {
  accept: 'Ваш ответ: подтверждаю заявку. Заявка отмечена «Связался». Это не бронь и не оплата: дату и цену согласуйте с заказчиком сами.',
  other_date: 'Ваш ответ: предложу другую дату. Заявка отмечена «Связался», бронь не создана. Напишите заказчику, какие даты есть.',
  no_seats: 'Ваш ответ: нет мест. Расписание не закрывал.',
  clarify: 'Ваш ответ: уточню. Заявку не закрывал.',
  self: 'Ваш ответ: свяжусь сам. Контакты заказчика в Telegram не отправляю.',
};

const ALREADY = 'Ответ по этой заявке уже записан. Повторно ничего не меняю.';

export function chatAnswerOfInbox(kind: InboxKind): ChatAnswerKind | null {
  return INBOX_KIND[kind] ?? null;
}

/**
 * Пять кнопок ответа («Подтвердить», «Другая дата», «Нет мест», «Уточнить»,
 * «Свяжусь сам»). `n` — номер строки списка, когда под ним кнопки
 * нескольких заявок; null — кнопки карточки одной заявки (кабинет в чате,
 * lib/chat-cabinet/screens), номер не нужен.
 */
export function chatAnswerButtons(
  n: number | null,
  kind: ChatAnswerKind,
  subjectId: string,
): Array<{ text: string; payload: string }> {
  const code = KIND_CODE[kind];
  const id = subjectId.toLowerCase();
  const mark = n === null ? '' : `${n} · `;
  return [
    { text: `${mark}Подтвердить`, payload: `ia:${ANSWER_CODE.accept}:${code}:${id}` },
    { text: `${mark}Другая дата`, payload: `ia:${ANSWER_CODE.other_date}:${code}:${id}` },
    { text: `${mark}Нет мест`, payload: `ia:${ANSWER_CODE.no_seats}:${code}:${id}` },
    { text: `${mark}Уточнить`, payload: `ia:${ANSWER_CODE.clarify}:${code}:${id}` },
    { text: `${mark}Свяжусь сам`, payload: `ia:${ANSWER_CODE.self}:${code}:${id}` },
  ];
}

export function parseChatAnswer(payload: string): { answer: ChatAnswer; kind: ChatAnswerKind; subjectId: string } | null {
  const match = /^ia:([adncm]):([lhsgb]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,18})$/i.exec(payload);
  if (!match) return null;
  const answer = CODE_ANSWER.get(match[1]!.toLowerCase());
  const kind = CODE_KIND.get(match[2]!.toLowerCase());
  if (!answer || !kind) return null;
  return { answer, kind, subjectId: match[3]!.toLowerCase() };
}

export function chatAnswerText(answer: ChatAnswer, already: boolean): string {
  return already ? ALREADY : ANSWER_LINE[answer];
}

/** Предмет есть во входящих этого партнёра. Чужой id не записываем. */
export function inboxOwns(
  items: readonly InboxItem[],
  kind: ChatAnswerKind,
  subjectId: string,
): boolean {
  return items.some((item) => chatAnswerOfInbox(item.kind) === kind && item.id.toLowerCase() === subjectId);
}

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

/**
 * Ответ, после которого заявка (`lead`) отмечается «Связался» — тем же
 * правилом владельца, что на сайте (lib/leads/owner-lead-status): чужую
 * заявку скоуп не тронет. Остальные ответы статус не меняют.
 */
export function chatAnswerMarksContacted(kind: ChatAnswerKind, answer: ChatAnswer): boolean {
  return kind === 'lead' && (answer === 'accept' || answer === 'other_date');
}
