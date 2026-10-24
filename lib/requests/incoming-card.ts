/**
 * Входящая заявка в чате Кузьмича: четыре кнопки для всех ролей, которым
 * заявка уже уходит лично (туроператор, перевозчик, жильё, снаряжение).
 *
 * Прокат пилота сюда не входит: у него свои «Беру» / «Не могу» (`rr:`),
 * и «Беру» отмечает дни в календаре. Менять эти слова перед демо нельзя.
 *
 * Нажатие пишет ответ и больше ничего: бронь не подтверждается, оплата
 * не открывается, места в расписании не закрываются. ПД в кнопке нет.
 * Payload короче 128 символов (лимит callback MAX).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_ID = /^\d{1,18}$/;

export const INCOMING_KINDS = ['lead', 'stay_request', 'stay_booking', 'gear', 'booking'] as const;
export type IncomingKind = (typeof INCOMING_KINDS)[number];

export type IncomingAnswer = 'accept' | 'no_seats' | 'clarify' | 'self';

const KIND_CODE: Record<IncomingKind, string> = {
  lead: 'l',
  stay_request: 'h',
  stay_booking: 's',
  gear: 'g',
  booking: 'b',
};

const CODE_KIND = new Map(Object.entries(KIND_CODE).map(([kind, code]) => [code, kind as IncomingKind]));

const ANSWER_CODE: Record<IncomingAnswer, string> = {
  accept: 'a',
  no_seats: 'n',
  clarify: 'c',
  self: 'm',
};

const CODE_ANSWER = new Map(Object.entries(ANSWER_CODE).map(([answer, code]) => [code, answer as IncomingAnswer]));

export const INCOMING_ANSWER_HINT =
  '«Принять» — беру заявку. «Нет мест» — не беру. «Уточнить» — сначала спрошу. «Свяжусь сам» — позвоню сам. '
  + 'Это ответ, не подтверждение брони и не оплата.';

const ANSWER_LINE: Record<IncomingAnswer, string> = {
  accept: 'Ваш ответ: принимаю заявку. Бронь этим не подтверждена, оплата не открыта.',
  no_seats: 'Ваш ответ: нет мест. Расписание не закрывал.',
  clarify: 'Ваш ответ: уточню. Заявку не закрывал.',
  self: 'Ваш ответ: свяжусь сам. Контакты заказчика в этом чате есть только в MAX.',
};

const ALREADY_LINE: Record<IncomingAnswer, string> = {
  accept: 'Ответ уже записан: принимаю. Повторно ничего не меняю.',
  no_seats: 'Ответ уже записан: нет мест. Повторно ничего не меняю.',
  clarify: 'Ответ уже записан: уточню. Повторно ничего не меняю.',
  self: 'Ответ уже записан: свяжусь сам. Повторно ничего не меняю.',
};

export function isIncomingSubjectId(value: string): boolean {
  return UUID.test(value) || INT_ID.test(value);
}

/** null — id не разобрать, такую кнопку вебхук не примет. */
export function incomingAnswerButtons(
  kind: IncomingKind,
  subjectId: string,
): Array<{ text: string; payload: string }> | undefined {
  if (!isIncomingSubjectId(subjectId)) return undefined;
  const id = UUID.test(subjectId) ? subjectId.toLowerCase() : subjectId;
  const code = KIND_CODE[kind];
  return [
    { text: 'Принять', payload: `ia:${ANSWER_CODE.accept}:${code}:${id}` },
    { text: 'Нет мест', payload: `ia:${ANSWER_CODE.no_seats}:${code}:${id}` },
    { text: 'Уточнить', payload: `ia:${ANSWER_CODE.clarify}:${code}:${id}` },
    { text: 'Свяжусь сам', payload: `ia:${ANSWER_CODE.self}:${code}:${id}` },
  ];
}

export function parseIncomingAnswer(payload: string): { answer: IncomingAnswer; kind: IncomingKind; subjectId: string } | null {
  const match = /^ia:([ancm]):([lhsgb]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,18})$/i.exec(payload);
  if (!match) return null;
  const answer = CODE_ANSWER.get(match[1]!.toLowerCase());
  const kind = CODE_KIND.get(match[2]!.toLowerCase());
  if (!answer || !kind) return null;
  const raw = match[3]!;
  return { answer, kind, subjectId: UUID.test(raw) ? raw.toLowerCase() : raw };
}

export function incomingAnswerText(answer: IncomingAnswer, already: boolean): string {
  return already ? ALREADY_LINE[answer] : ANSWER_LINE[answer];
}

const KIND_WORD: Record<IncomingKind, string> = {
  lead: 'заявка',
  stay_request: 'заявка на жильё',
  stay_booking: 'бронь жилья',
  gear: 'заявка на снаряжение',
  booking: 'бронь тура',
};

/** Менеджеру Ведара. Без имени и телефона заказчика. */
export function incomingManagerText(opts: {
  partnerName: string;
  kind: IncomingKind;
  subjectId: string;
  answer: IncomingAnswer;
}): string {
  const word: Record<IncomingAnswer, string> = {
    accept: 'принимаю',
    no_seats: 'нет мест',
    clarify: 'уточню',
    self: 'свяжусь сам',
  };
  const name = opts.partnerName.replace(/[<>&]/g, '');
  return [
    `<b>Ответ партнёра:</b> ${word[opts.answer]}`,
    `Кто: ${name}`,
    `Предмет: ${KIND_WORD[opts.kind]} <code>${opts.subjectId}</code>`,
    'Статус брони и оплата не менялись.',
  ].join('\n');
}

/** Правка сообщения заявки: исходный текст экранируется, строка ответа — HTML. */
export function incomingEditText(originalText: string | null | undefined, replyHtml: string): string {
  const tail = `\n\n${replyHtml}`;
  const head = (originalText ?? '').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!head) return replyHtml;
  const room = 4000 - tail.length;
  return (head.length > room ? `${head.slice(0, Math.max(0, room - 1))}…` : head) + tail;
}
