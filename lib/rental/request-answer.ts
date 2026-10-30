/**
 * «Беру» / «Не могу» на заявке партнёру: прокат (прокатчик, пилот) и машина
 * целиком (перевозчик, #2862 этап A, 30.10). Чистые функции: разбор кнопки,
 * дни аренды, тексты ответа. Запись — в request-answer-store, дверь — в
 * request-answer-flow.
 *
 * Payload `rr:y:<leadId>` / `rr:n:<leadId>` короче 128 символов (лимит
 * callback MAX) и 64 байт (лимит callback_data Telegram). Партнёр и право
 * нажатия в payload не кладутся: их берёт вебхук из привязанного чата. Вид
 * заявки (прокат или машина) в кнопке тоже не лежит — его читает сервер из
 * самого лида (`source_data.kind`): одна кнопка, два смысла по данным.
 *
 * У перевозчика «Беру» значит «готов выполнить и свяжусь с заказчиком», а не
 * бронь: машина заявкой не закрепляется, занятость система не ведёт (§14).
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

/** Вид заявки партнёру: прокат машины без водителя или машина целиком с водителем. */
export type PartnerRequestKind = 'car_rental' | 'charter';

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

/**
 * Дошёл ли ответ до заказчика в переписке заявки (1350): true — записан и
 * виден (в MAX или на странице заявки), false — не записался, null — не
 * проверяли (перевозчик без переписки). Третий исход назван, а не спрятан.
 */
export type ClientTold = boolean | null;

export type AnswerTell =
  | { kind: 'decline' }
  | { kind: 'take'; from: string; to: string; marked: number }
  | { kind: 'take_no_car' }
  | { kind: 'take_bad_dates' }
  /** Перевозчик берёт заявку на машину: без отметки дней и без закрепления машины. */
  | { kind: 'charter_take'; clientTold: ClientTold }
  | { kind: 'charter_decline'; clientTold: ClientTold }
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
    case 'charter_take':
      return `<b>Ваш ответ:</b> беру. Машина заявкой не закрепляется — свяжитесь с заказчиком и договоритесь напрямую. ${clientToldLine(tell.clientTold, 'берёте заявку и свяжетесь')}`;
    case 'charter_decline':
      return `<b>Ваш ответ:</b> не могу. Заявка остаётся у менеджера Ведара. ${clientToldLine(tell.clientTold, 'не можете выполнить заявку')}`;
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

/** Что сказано заказчику — тремя исходами: сообщил / не ушло / не отправляли. */
function clientToldLine(told: ClientTold, what: string): string {
  if (told === true) return `Заказчику сообщил, что вы ${what}.`;
  if (told === false) return 'Сообщение заказчику не ушло — свяжитесь с ним сами по телефону из заявки.';
  return '';
}

/**
 * Заказчику в переписку заявки (1350): ответ перевозчика его словами, без
 * суммы и без обещания машины — машина заявкой не закрепляется (§14).
 * Текст уходит в MAX клиента и на страницу заявки: там он без разметки.
 */
export function clientCharterAnswerText(partnerName: string, answer: RequestAnswer): string {
  const who = partnerName.trim() || 'Перевозчик';
  return answer === 'take'
    ? `Перевозчик «${who}» берёт вашу заявку и свяжется с вами по телефону из заявки. Условия и сумму вы согласуете с ним напрямую.`
    : `Перевозчик «${who}» не может выполнить эту заявку. Заявка остаётся у менеджера Ведара — он свяжется с вами.`;
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
  /** Прокат (по умолчанию — так звали до 30.10) или машина целиком. */
  kind?: PartnerRequestKind;
  partnerName: string;
  leadId: string;
  answer: RequestAnswer;
  /** У проката — машина; у заявки на машину — направление. */
  carTitle: string | null;
  from: string | null;
  to: string | null;
  marked: number | null;
}): string {
  const who = escapeHtml(opts.partnerName);
  const verb = opts.answer === 'take' ? 'беру' : 'не могу';
  if (opts.kind === 'charter') {
    const lines = [
      `Перевозчик «${who}» ответил «${verb}» на заявку на машину <code>${escapeHtml(opts.leadId)}</code>.`,
    ];
    if (opts.carTitle) lines.push(`Направление: ${escapeHtml(opts.carTitle)}`);
    if (opts.from) lines.push(opts.to ? `Даты: с ${escapeHtml(opts.from)} по ${escapeHtml(opts.to)}` : `Дата выезда: ${escapeHtml(opts.from)}`);
    lines.push(opts.answer === 'take'
      ? 'Перевозчик свяжется с заказчиком сам; машина заявкой не закреплена.'
      : 'Нужен другой перевозчик: заявка остаётся у менеджера.');
    return lines.join('\n');
  }
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
