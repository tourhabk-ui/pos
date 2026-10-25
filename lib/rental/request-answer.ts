/**
 * «Беру» / «Не могу» на заявке проката. Чистые функции: разбор кнопки,
 * дни аренды, тексты ответа. Запись — в request-answer-store, дверь — в
 * request-answer-flow.
 *
 * Payload `rr:y:<leadId>` / `rr:n:<leadId>` короче 128 символов (лимит
 * callback MAX) и 64 байт (лимит callback_data Telegram). Партнёр и право
 * нажатия в payload не кладутся: их берёт вебхук из привязанного чата.
 *
 * В списке «Заявки» под одним сообщением несколько пар кнопок. Там кнопка
 * несёт номер строки (`rr:y:<leadId>:2`, «Беру №2»): ответ необратим, и
 * пара без номера легко нажимается не у той заявки. Нажатие из списка
 * список не правит — ответ уходит отдельным сообщением с номером, машиной
 * и датами, а кнопки остальных заявок остаются на месте.
 */

import { isRealDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';

const LEAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Самая длинная аренда в одной заявке — то же ограничение, что у формы. */
const MAX_SPAN_DAYS = 30;

export type RequestAnswer = 'take' | 'decline';

export function isLeadId(value: string): boolean {
  return LEAD_ID.test(value);
}

/** Номер строки в списке «Заявки»: от 1 до 9, одна цифра в payload. */
function isListNo(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9;
}

/**
 * Кнопки заявки. undefined — id не uuid, такую кнопку вебхук не разберёт.
 * listNo — номер строки в списке: кнопка называет его и несёт в payload.
 */
export function rentalAnswerButtons(
  leadId: string,
  listNo?: number,
): Array<{ text: string; payload: string }> | undefined {
  if (!isLeadId(leadId)) return undefined;
  const id = leadId.toLowerCase();
  if (listNo !== undefined && !isListNo(listNo)) return undefined;
  const tail = listNo === undefined ? '' : `:${listNo}`;
  const label = listNo === undefined ? '' : ` №${listNo}`;
  return [
    { text: `Беру${label}`, payload: `rr:y:${id}${tail}` },
    { text: `Не могу${label}`, payload: `rr:n:${id}${tail}` },
  ];
}

export function parseRequestAnswer(
  payload: string,
): { answer: RequestAnswer; leadId: string; listNo?: number } | null {
  const match = /^rr:([yn]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([1-9]))?$/i.exec(payload);
  if (!match) return null;
  const answer: RequestAnswer = match[1]!.toLowerCase() === 'y' ? 'take' : 'decline';
  const leadId = match[2]!.toLowerCase();
  return match[3] ? { answer, leadId, listNo: Number(match[3]) } : { answer, leadId };
}

/**
 * Первая строка ответа на нажатие из списка: какая это заявка. Ответ уходит
 * отдельным сообщением, и без неё было бы не видно, на что он дан. HTML.
 */
export function requestAnswerListHead(opts: {
  listNo: number;
  title: string | null;
  from: string | null;
  to: string | null;
}): string {
  const car = opts.title?.trim() ? escapeHtml(opts.title.trim()) : 'машина в заявке не названа';
  const dates = opts.from && opts.to
    ? `${escapeHtml(opts.from)} — ${escapeHtml(opts.to)}`
    : 'даты не записаны';
  return `<b>Заявка №${opts.listNo} из списка:</b> ${car}, ${dates}.`;
}

/**
 * Дни аренды включительно. null — даты не календарные, конец раньше начала
 * или срок длиннее 30 дней: отмечать такой ряд нельзя, это была бы догадка.
 */
export function rentalSpanDays(from: string, to: string): string[] | null {
  if (!isRealDate(from) || !isRealDate(to) || to < from) return null;
  const days: string[] = [];
  let cur = from;
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    days.push(cur);
    if (cur === to) return days;
    cur = shiftDate(cur, 1);
  }
  return null;
}

export type AnswerTell =
  | { kind: 'decline' }
  | { kind: 'take'; from: string; to: string; marked: number }
  | { kind: 'take_no_car' }
  | { kind: 'take_bad_dates' }
  | { kind: 'retry' }
  | { kind: 'already'; answer: RequestAnswer }
  | { kind: 'not_yours' }
  | { kind: 'missing' }
  | { kind: 'unread' }
  | { kind: 'not_pilot' }
  | { kind: 'unparsed' };

/** Строка прокатчику. HTML. Повтора имени и телефона заказчика здесь нет. */
export function partnerAnswerText(tell: AnswerTell): string {
  switch (tell.kind) {
    case 'decline':
      return '<b>Ваш ответ:</b> не могу. Дни не отмечал.';
    case 'take':
      return `<b>Ваш ответ:</b> беру. Дни с ${escapeHtml(tell.from)} по ${escapeHtml(tell.to)} отмечены занятыми (${tell.marked}).`;
    case 'take_no_car':
      return '<b>Ваш ответ:</b> беру. Машину в вашем прайсе не нашёл — дни не отметил.';
    case 'take_bad_dates':
      return '<b>Ваш ответ:</b> беру. Даты в заявке не разобрать — дни не отметил.';
    case 'retry':
      return 'Ответ не записал: календарь не ответил. Нажмите кнопку ещё раз.';
    case 'already':
      return tell.answer === 'take'
        ? 'Ответ уже записан: беру. Повторно дни не отмечаю.'
        : 'Ответ уже записан: не могу. Дни не отмечал.';
    case 'not_yours':
      return 'Эта заявка не ваша. Ответ не записан.';
    case 'missing':
      return 'Заявку не нашёл. Ответ не записан.';
    case 'unread':
      return 'Не удалось прочитать заявку. Ответ не записан.';
    case 'not_pilot':
      return 'Ответ на заявку в этом чате не принимаю. Ничего не записано.';
    case 'unparsed':
      return 'Кнопка заявки не распознана. Ответ не записан.';
  }
}

/**
 * Текст правки сообщения заявки: исходный текст (из MAX приходит без
 * разметки — экранируется) и строка ответа. Кнопки вызывающий снимает.
 */
export function requestAnswerEditText(originalText: string | null | undefined, replyHtml: string): string {
  const tail = `\n\n${replyHtml}`;
  const head = escapeHtml((originalText ?? '').trim());
  if (!head) return replyHtml;
  const room = 4000 - tail.length;
  return (head.length > room ? `${head.slice(0, Math.max(0, room - 1))}…` : head) + tail;
}

/**
 * Менеджеру Ведара, в рабочий чат Telegram. Без имени, телефона и пожеланий
 * заказчика: их менеджер уже видел в своей копии заявки.
 */
export function managerAnswerText(opts: {
  partnerName: string;
  leadId: string;
  answer: RequestAnswer;
  carTitle: string | null;
  from: string | null;
  to: string | null;
  marked: number | null;
}): string {
  const who = escapeHtml(opts.partnerName);
  const verb = opts.answer === 'take' ? 'беру' : 'не могу';
  const lines = [
    `Прокатчик «${who}» ответил «${verb}» на заявку <code>${escapeHtml(opts.leadId)}</code>.`,
  ];
  if (opts.carTitle) lines.push(`Машина: ${escapeHtml(opts.carTitle)}`);
  if (opts.from && opts.to) lines.push(`Даты: с ${escapeHtml(opts.from)} по ${escapeHtml(opts.to)}`);
  if (opts.answer === 'decline') lines.push('Дни не отмечал.');
  else if (opts.marked === null) lines.push('Дни не отметил: машину в прайсе или даты разобрать не удалось.');
  else lines.push(`Дни отмечены занятыми: ${opts.marked}.`);
  return lines.join('\n');
}
