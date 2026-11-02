/**
 * Кнопки ответа на входящую заявку в чате оператора.
 * Нажатие записывает ответ и не подтверждает бронь и не открывает оплату.
 * Имени и телефона туриста в подписи кнопки нет.
 *
 * Без базы: модуль читает и уведомление о новой заявке (lib/notifications/lead-notify).
 * Запись ответа — lib/requests/chat-answer.
 */

import type { InboxItem } from '@/lib/crm/inbox';
import type { InboxKind } from '@/lib/crm/inbox-kinds';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';

export const CHAT_ANSWER_KINDS = ['lead', 'stay_request', 'stay_booking', 'gear', 'booking'] as const;
export type ChatAnswerKind = (typeof CHAT_ANSWER_KINDS)[number];
export type ChatAnswer = 'accept' | 'other_date' | 'no_seats' | 'clarify' | 'self' | 'decline';

/**
 * Причина отказа (решение владельца 02.11: отказ — отдельный статус с
 * причиной). Код — одна буква в payload `ia:r<код>:…`.
 */
export const DECLINE_REASONS = ['seats', 'weather', 'dates', 'group', 'other'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];
const REASON_CODE: Record<DeclineReason, string> = { seats: 's', weather: 'w', dates: 'd', group: 'g', other: 'o' };
const CODE_REASON = new Map(Object.entries(REASON_CODE).map(([r, c]) => [c, r as DeclineReason]));
export const DECLINE_REASON_LABEL: Record<DeclineReason, string> = {
  seats: 'Нет мест',
  weather: 'Погода, безопасность',
  dates: 'Даты не подходят',
  group: 'Не подходит группа',
  other: 'Другое',
};

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
  decline: 'r',
};
const CODE_ANSWER = new Map(Object.entries(ANSWER_CODE).map(([answer, code]) => [code, answer as ChatAnswer]));

const INBOX_KIND: Partial<Record<InboxKind, ChatAnswerKind>> = {
  operator_booking: 'booking',
  lead: 'lead',
  accommodation_booking: 'stay_booking',
  gear_rental: 'gear',
};

const ANSWER_LINE: Record<ChatAnswer, string> = {
  accept: 'Ваш ответ: подтверждаю заявку. Заявка отмечена «Связался». Бронь этим не подтверждена, оплата не открыта: дату и цену согласуйте с заказчиком сами.',
  other_date: 'Ваш ответ: предложу другую дату. Заявка отмечена «Связался», бронь не создана. Напишите заказчику, какие даты есть.',
  no_seats: 'Ваш ответ: нет мест. Расписание не закрывал.',
  clarify: 'Ваш ответ: уточню. Заявку не закрывал.',
  self: 'Ваш ответ: свяжусь сам. Контакты заказчика в Telegram не отправляю.',
  decline: 'Ваш ответ: отказ, записан к заявке. Туристу из чата ничего не ушло, бронь и оплата не менялись.',
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
    { text: `${mark}Подтвердить`, payload: signPayload(`ia:${ANSWER_CODE.accept}:${code}:${id}`) },
    { text: `${mark}Другая дата`, payload: signPayload(`ia:${ANSWER_CODE.other_date}:${code}:${id}`) },
    { text: `${mark}Нет мест`, payload: signPayload(`ia:${ANSWER_CODE.no_seats}:${code}:${id}`) },
    { text: `${mark}Уточнить`, payload: signPayload(`ia:${ANSWER_CODE.clarify}:${code}:${id}`) },
    { text: `${mark}Свяжусь сам`, payload: signPayload(`ia:${ANSWER_CODE.self}:${code}:${id}`) },
  ];
}

const ASK_LINE: Record<Exclude<ChatAnswer, 'decline'>, string> = {
  accept: 'Записать ответ «Подтверждаю заявку»? Бронь этим не подтверждается, оплата не открывается.',
  other_date: 'Записать ответ «Предложу другую дату»? Заявка будет отмечена «Связался».',
  no_seats: 'Записать ответ «Нет мест»? Расписание не закрывается.',
  clarify: 'Записать ответ «Уточню»?',
  self: 'Записать ответ «Свяжусь сам»?',
};

/** Второе нажатие (решение владельца 02.11): «Да» пишет ответ, «Нет» ничего не меняет. */
export function chatAnswerAsk(
  answer: Exclude<ChatAnswer, 'decline'>, kind: ChatAnswerKind, subjectId: string,
): { text: string; rows: Array<Array<{ text: string; payload: string }>> } {
  const id = subjectId.toLowerCase();
  return {
    text: ASK_LINE[answer],
    rows: [[
      { text: 'Да', payload: signPayload(`ia:y${ANSWER_CODE[answer]}:${KIND_CODE[kind]}:${id}`) },
      { text: 'Нет', payload: signPayload('ia:no') },
    ]],
  };
}

export const ASK_CANCELLED = 'Хорошо, ответ не записан. Карточка заявки без изменений.';

/**
 * «Отказать» — кнопка, открывающая выбор причины (`ia:x:…`, ничего не
 * пишет), и кнопки причин (`ia:r<код>:…`, пишут отказ один раз).
 */
export function declineButton(kind: ChatAnswerKind, subjectId: string): { text: string; payload: string } {
  return { text: 'Отказать', payload: signPayload(`ia:x:${KIND_CODE[kind]}:${subjectId.toLowerCase()}`) };
}

export function declineReasonButtons(kind: ChatAnswerKind, subjectId: string): Array<Array<{ text: string; payload: string }>> {
  const id = subjectId.toLowerCase();
  const b = (r: DeclineReason) => ({ text: DECLINE_REASON_LABEL[r], payload: signPayload(`ia:r${REASON_CODE[r]}:${KIND_CODE[kind]}:${id}`) });
  return [[b('seats'), b('weather')], [b('dates'), b('group')], [b('other')]];
}

export const DECLINE_PICK_TEXT = 'Почему отказ? Выберите причину — она запишется к заявке. Туристу из чата ничего не уйдёт, бронь и оплата не меняются.';

export type ParsedChatAnswer =
  /** confirmed=false — первое нажатие: только вопрос «Записать?» (решение владельца 02.11: второе «Да»). */
  | { answer: Exclude<ChatAnswer, 'decline'>; kind: ChatAnswerKind; subjectId: string; confirmed: boolean }
  | { answer: 'decline'; reason: DeclineReason; kind: ChatAnswerKind; subjectId: string }
  | { answer: 'decline_pick'; kind: ChatAnswerKind; subjectId: string };

const SUBJECT = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\\d{1,18})';

export function parseChatAnswer(payload: string): ParsedChatAnswer | null {
  const pick = new RegExp(`^ia:x:([lhsgb]):${SUBJECT}$`, 'i').exec(payload);
  if (pick) {
    const kind = CODE_KIND.get(pick[1]!.toLowerCase());
    return kind ? { answer: 'decline_pick', kind, subjectId: pick[2]!.toLowerCase() } : null;
  }
  const decline = new RegExp(`^ia:r([swdgo]):([lhsgb]):${SUBJECT}$`, 'i').exec(payload);
  if (decline) {
    const reason = CODE_REASON.get(decline[1]!.toLowerCase());
    const kind = CODE_KIND.get(decline[2]!.toLowerCase());
    return reason && kind ? { answer: 'decline', reason, kind, subjectId: decline[3]!.toLowerCase() } : null;
  }
  const match = new RegExp(`^ia:(y?)([adncm]):([lhsgb]):${SUBJECT}$`, 'i').exec(payload);
  if (!match) return null;
  const answer = CODE_ANSWER.get(match[2]!.toLowerCase());
  const kind = CODE_KIND.get(match[3]!.toLowerCase());
  if (!answer || answer === 'decline' || !kind) return null;
  return { answer, kind, subjectId: match[4]!.toLowerCase(), confirmed: match[1]!.toLowerCase() === 'y' };
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

/**
 * Ответ, после которого заявка (`lead`) отмечается «Связался» — тем же
 * правилом владельца, что на сайте (lib/leads/owner-lead-status): чужую
 * заявку скоуп не тронет. Остальные ответы статус не меняют.
 */
export function chatAnswerLeadStatus(kind: ChatAnswerKind, answer: ChatAnswer): 'contacted' | 'lost' | null {
  if (kind !== 'lead') return null;
  if (answer === 'decline') return 'lost';
  return answer === 'accept' || answer === 'other_date' ? 'contacted' : null;
}

export function chatAnswerMarksContacted(kind: ChatAnswerKind, answer: ChatAnswer): boolean {
  return kind === 'lead' && (answer === 'accept' || answer === 'other_date');
}
