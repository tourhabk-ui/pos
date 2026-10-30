/**
 * Ответ хозяина жилья на заявку одной кнопкой (слово владельца 30.10: хозяин
 * «Кутхи» «сейчас на бумажке посмотрю, когда занято» и с MAX не разберётся —
 * нужен очень понятный интерфейс).
 *
 * Три кнопки под заявкой в MAX и в карточке кабинета в чате:
 *   «Свободно, беру» — хозяин ждёт гостя и позвонит ему сам;
 *   «Занято»         — на эти даты места нет;
 *   «Позвоню сам»    — хозяин перезвонит и договорится по телефону.
 *
 * Чистые функции: разбор кнопки и тексты. Запись и следствия — в
 * owner-answer-flow. Payload `sa:<f|b|c>:<uuid заявки>` короче 64 байт
 * (лимит callback_data Telegram). Партнёр и право нажатия в payload не
 * кладутся: их берёт вебхук из привязанного чата (как у «Беру» перевозчика).
 *
 * Ответ — не бронь и не оплата: даты и цену подтверждает хозяин, платформа
 * оплату не принимает (1206). Поэтому ни одно слово здесь не говорит
 * «забронировано».
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { ruDate } from '@/lib/stay/stay-request';

export type StayOwnerAnswer = 'free' | 'busy' | 'call';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE: Readonly<Record<StayOwnerAnswer, string>> = { free: 'f', busy: 'b', call: 'c' };
const ANSWER_OF_CODE: Readonly<Record<string, StayOwnerAnswer>> = { f: 'free', b: 'busy', c: 'call' };

export const STAY_ANSWER_WORDS: Readonly<Record<StayOwnerAnswer, string>> = {
  free: 'Свободно, беру',
  busy: 'Занято',
  call: 'Позвоню сам',
};

export function isStayAnswerPayload(payload: string): boolean {
  return payload.startsWith('sa:');
}

/** Кнопки заявки. undefined — id не uuid, такую кнопку вебхук не разберёт. */
export function stayAnswerButtons(requestId: string): Array<{ text: string; payload: string }> | undefined {
  if (!UUID.test(requestId)) return undefined;
  const id = requestId.toLowerCase();
  return (['free', 'busy', 'call'] as const).map((a) => ({ text: STAY_ANSWER_WORDS[a], payload: `sa:${CODE[a]}:${id}` }));
}

export function parseStayAnswerPress(payload: string): { answer: StayOwnerAnswer; requestId: string } | null {
  const m = /^sa:([fbc]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(payload);
  if (!m) return null;
  return { answer: ANSWER_OF_CODE[m[1]!.toLowerCase()]!, requestId: m[2]!.toLowerCase() };
}

/** Что известно о заявке после записи ответа — для слов гостю и менеджеру. */
export interface StayAnswerFacts {
  accommodationName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
}

/**
 * Дошёл ли ответ до гостя в переписке заявки (1349): true — записан и виден
 * (в MAX гостя или на странице заявки), false — не записался, null — не
 * отправляли. Третий исход назван, а не спрятан.
 */
export type GuestTold = boolean | null;

export type StayAnswerTell =
  | { kind: 'answered'; answer: StayOwnerAnswer; guestTold: GuestTold }
  | { kind: 'already'; answer: StayOwnerAnswer }
  | { kind: 'not_yours' }
  | { kind: 'missing' }
  | { kind: 'unread' }
  | { kind: 'retry' }
  | { kind: 'unparsed' };

function datesWords(f: Pick<StayAnswerFacts, 'checkIn' | 'checkOut'>): string {
  return `с ${ruDate(f.checkIn)} по ${ruDate(f.checkOut)}`;
}

/**
 * Гостю — в переписку заявки, словами хозяина. Без суммы: цену и условия
 * подтверждает хозяин по телефону. Текст уходит в MAX гостя и на страницу
 * заявки — там он без разметки.
 */
export function guestStayAnswerText(f: StayAnswerFacts, answer: StayOwnerAnswer): string {
  const who = f.accommodationName.trim() || 'Хозяин жилья';
  const dates = datesWords(f);
  switch (answer) {
    case 'free':
      return `«${who}»: свободно, ждём вас ${dates}. Хозяин позвонит вам по телефону из заявки — цену и условия подтвердит он. Через Ведар оплаты нет.`;
    case 'busy':
      return `«${who}»: на даты ${dates} занято. Другие даты можно спросить у хозяина по телефону с карточки или выбрать другое жильё на Ведаре.`;
    case 'call':
      return `«${who}»: хозяин позвонит вам сам по телефону из заявки и договорится о датах и цене.`;
  }
}

/** Что сказано гостю — тремя исходами: сообщил / не ушло / не отправляли. */
function guestToldLine(told: GuestTold): string {
  if (told === true) return 'Гостю сообщил.';
  if (told === false) return 'Сообщение гостю не ушло — позвоните ему по телефону из заявки.';
  return '';
}

/** Хозяину — строка под заявкой. HTML. Повтора имени и телефона гостя здесь нет. */
export function ownerStayAnswerText(tell: StayAnswerTell): string {
  switch (tell.kind) {
    case 'answered': {
      const word = STAY_ANSWER_WORDS[tell.answer].toLowerCase();
      const tail = tell.answer === 'free'
        ? 'Позвоните гостю, чтобы договориться о цене и заезде.'
        : tell.answer === 'busy'
          ? 'Больше ничего делать не нужно.'
          : 'Телефон гостя — в заявке выше.';
      return `<b>Ваш ответ:</b> ${escapeHtml(word)}. ${guestToldLine(tell.guestTold)} ${tail}`.replace(/\s+/g, ' ').trim();
    }
    case 'already':
      return `Ответ уже записан: ${escapeHtml(STAY_ANSWER_WORDS[tell.answer].toLowerCase())}. Второй раз ничего не меняю.`;
    case 'not_yours':
      return 'Эта заявка не ваша. Ответ не записан.';
    case 'missing':
      return 'Заявку не нашёл. Ответ не записан.';
    case 'unread':
      return 'Не удалось прочитать заявку. Ответ не записан — нажмите кнопку ещё раз.';
    case 'retry':
      return 'Ответ не записал: база не ответила. Нажмите кнопку ещё раз.';
    case 'unparsed':
      return 'Кнопка заявки не распознана. Ответ не записан.';
  }
}

/** Менеджеру Ведара, в рабочий чат. Без имени и телефона гостя — он видел их в своей копии заявки. */
export function managerStayAnswerText(opts: { partnerName: string; requestId: string; answer: StayOwnerAnswer; facts: StayAnswerFacts }): string {
  const word = STAY_ANSWER_WORDS[opts.answer].toLowerCase();
  const lines = [
    `Хозяин жилья «${escapeHtml(opts.partnerName)}» ответил «${word}» на заявку <code>${escapeHtml(opts.requestId)}</code>.`,
    `Объект: ${escapeHtml(opts.facts.accommodationName)} · ${datesWords(opts.facts)} · гостей: ${opts.facts.guests}`,
  ];
  if (opts.answer === 'busy') lines.push('Гостю сказано, что занято; если нужна помощь с другим жильём — он напишет или позвонит.');
  return lines.join('\n');
}

/** Подпись под кнопками в сообщении о заявке и в карточке кабинета. */
export const STAY_ANSWER_HINT = 'Нажмите одну кнопку: гость получит ваш ответ. Больше ничего делать не нужно. Даты и цену подтверждаете вы, платформа оплату не принимает.';
