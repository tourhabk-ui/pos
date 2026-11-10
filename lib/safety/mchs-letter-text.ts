/**
 * Письмо с данными выезда для МЧС — пока тест.
 *
 * Слово владельца 10.11: «api мчс нет или нам не дают форма сложная можем
 * попробывать пока письмом на flo@vedarai.ru потом после тестов свяжусь с
 * МЧС». Оператор и гид из кабинета в чате отправляют данные выезда письмом.
 *
 * ── Что письмо есть и чем оно не является ──────────────────────────────────
 *
 * Получатель — ящик Ведара (`MCHS_LETTER.to`), НЕ МЧС. Письмо в ведомство не
 * уходит, заявкой не является, и чат обязан говорить это словами на каждом
 * экране: «отправлено» без «куда» человек прочитает как «подано в МЧС» и
 * форму МЧС уже не откроет (§0, §4.0). Заявку по-прежнему подаёт руководитель
 * группы — кнопка «Открыть форму МЧС» остаётся на всех экранах.
 *
 * Получатель и признак теста — константы в коде, не env: перевод на адрес
 * МЧС — видимый коммит вместе с текстами экранов, согласием на передачу ПД и
 * словом владельца после его разговора с МЧС. Сторож
 * (tests/unit/mchs-letter.test.ts) держит связку: пока `test: true`,
 * получатель — адрес на vedarai.ru, а тексты называют письмо тестовым.
 *
 * В письме — имя и телефон контактного лица каждой брони (ПД туристов).
 * В чат они отсюда не возвращаются: ответ кабинета после отправки ПД не несёт.
 * В журнал (`mchs_letters`, 1415) пишется только счёт людей и броней.
 */

import { escapeHtml, safeSubject } from '@/lib/text/escape-html';
import { MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import { mchsGroupText, type MchsGroup } from '@/lib/safety/mchs-chat';

/** Куда уходит письмо. `test: true` — ящик Ведара, в МЧС письмо не отправляется. */
export const MCHS_LETTER = { to: 'flo@vedarai.ru', test: true } as const;

/** Повтор по тому же выезду раньше этого срока не отправляется (двойное нажатие). */
export const MCHS_LETTER_REPEAT_MS = 10 * 60_000;

export type MchsLetterOutcome = 'sent' | 'failed' | 'not_configured';

/** Кто отправляет: карточка партнёра и её роль словом. */
export interface MchsLetterSender {
  partnerId: string;
  partnerName: string;
  role: 'operator' | 'guide';
  channel: 'max' | 'telegram';
}

const ROLE_WORD: Readonly<Record<MchsLetterSender['role'], string>> = { operator: 'туроператор', guide: 'гид' };

function ruDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ymd;
}

/** Шапка письма: что это тест и что в МЧС оно не уходило. */
export const MCHS_LETTER_TEST_BANNER =
  'ТЕСТОВОЕ ПИСЬМО Ведара. В МЧС не отправлялось и заявкой на регистрацию группы не является.';

export function mchsLetterSubject(g: MchsGroup): string {
  const mark = MCHS_LETTER.test ? '[ТЕСТ] ' : '';
  return safeSubject(`${mark}Регистрация туристской группы: ${g.title}, ${ruDate(g.date)} — ${ruDate(g.endDate)}`);
}

/**
 * Тело письма (HTML). Текст выезда — тот же, что видит оператор в чате
 * (`mchsGroupText`, всё введённое людьми уже экранировано).
 */
export function mchsLetterHtml(g: MchsGroup, sender: MchsLetterSender, nowMs: number): string {
  const lines: string[] = [];
  if (MCHS_LETTER.test) lines.push(`<p><b>${MCHS_LETTER_TEST_BANNER}</b></p>`);
  lines.push(`<p>Отправил: ${escapeHtml(sender.partnerName)} (${ROLE_WORD[sender.role]}) из кабинета Ведара в чате.</p>`);
  lines.push(`<p>${mchsGroupText(g, nowMs, { allContacts: true }).replace(/\n/g, '<br>')}</p>`);
  lines.push(`<p>Официальная форма МЧС: <a href="${MCHS_ONLINE_FORM_URL}">${MCHS_ONLINE_FORM_URL}</a></p>`);
  return lines.join('\n');
}

// ── Что уже уходило по выезду ───────────────────────────────────────────────

/** Принятое почтой письмо по выезду — строка журнала глазами спрашивающей карточки. */
export interface MchsSentLetter {
  /** Момент отправки строкой базы. */
  at: string;
  /** Отправлено меньше MCHS_LETTER_REPEAT_MS назад. */
  recent: boolean;
  /** Отправила та же карточка, что спрашивает. */
  mine: boolean;
  /** Отправила карточка-владелец тура: в её письме все брони выезда. */
  whole: boolean;
  people: number;
  bookings: number;
}

/** Что отправил бы сейчас нажавший: видит ли он весь выезд и сколько в его группе. */
export interface MchsLetterNow {
  senderWhole: boolean;
  people: number;
  bookings: number;
}

/**
 * Несёт ли прошлое письмо то же, что ушло бы сейчас. Состав письма — по
 * карточке: владелец тура видит все брони выезда, гид команды — назначенные
 * ему (у брони один гид, так что наборы двух гидов не пересекаются).
 *
 *  - своё письмо — тот же взгляд на выезд;
 *  - письмо владельца тура — в нём все брони, значит и брони спрашивающего;
 *  - чужое письмо гида покрывает владельца, только когда счёт людей и броней
 *    совпал: набор гида — часть набора владельца, равный счёт значит тот же
 *    набор. Другого гида оно не покрывает никогда.
 */
export function mchsLetterCovers(l: MchsSentLetter, now: MchsLetterNow): boolean {
  if (l.mine || l.whole) return true;
  return now.senderWhole && l.people === now.people && l.bookings === now.bookings;
}

/**
 * Письмо, из-за которого повтор сейчас не уходит: свежее и покрывающее. Свежее
 * письмо о части выезда повтор не запрещает — иначе человеку сказали бы «уже
 * отправлено» о группе, которой в том письме не было (ревью PR 3188).
 */
export function blockingMchsLetter(letters: readonly MchsSentLetter[], now: MchsLetterNow): MchsSentLetter | null {
  return letters.find((l) => l.recent && mchsLetterCovers(l, now)) ?? null;
}

/** Чего в прошлом письме нет для того, кто смотрит выезд. */
export type MchsLetterGap = 'none' | 'part' | 'other';

/**
 * `part` — смотрит владелец тура, а письмо чужое и о части броней;
 * `other` — смотрит гид, а письмо другого гида: его броней в нём нет вовсе.
 */
export function mchsLetterGap(l: MchsSentLetter, now: MchsLetterNow): MchsLetterGap {
  if (mchsLetterCovers(l, now)) return 'none';
  return now.senderWhole ? 'part' : 'other';
}

/**
 * Письмо для строки под выездом — тем же правилом покрытия, что и запрет
 * повтора: сперва самое свежее из тех, что несут группу смотрящего, иначе
 * просто самое свежее, и тогда строка говорит, чего в нём нет. Первая редакция
 * показывала последнее письмо как есть: второй гид с тем же числом людей читал
 * «в нём 2 чел., с другой карточки» как «мою группу уже отправили», а владелец
 * тура терял из виду собственное письмо обо всём выезде, стоило гиду отправить
 * своё позже (ревью PR 3188).
 */
export function shownMchsLetter(
  letters: readonly MchsSentLetter[], now: MchsLetterNow,
): { letter: MchsSentLetter; gap: MchsLetterGap } | null {
  const letter = letters.find((l) => mchsLetterCovers(l, now)) ?? letters[0];
  return letter ? { letter, gap: mchsLetterGap(letter, now) } : null;
}

const GAP_WORDS: Readonly<Record<MchsLetterGap, string>> = {
  none: '',
  part: ' Это письмо о части выезда — остальных броней в нём нет.',
  other: ' Ваших броней в нём нет.',
};

/** Что было в письме: счёт и чьё оно. Имён в журнале нет — только счёт. */
function letterContent(l: Pick<MchsSentLetter, 'people' | 'bookings' | 'mine'>): string {
  return `в нём ${l.people} чел., броней — ${l.bookings}${l.mine ? '' : ', отправлено с другой карточки этого выезда'}`;
}

/** Слова кабинета в чате о письме. Все называют, куда оно ушло и чем не является. */
export const MCHS_LETTER_TEXT = {
  button: 'Отправить письмом (тест)',
  yes: 'Да, отправить',
  askHead: '<b>Отправить данные выезда письмом?</b>',
  askWhere: 'Это проверка: письмо уйдёт на тестовый ящик Ведара, не в МЧС. Заявкой в МЧС оно не станет — её по-прежнему подаёте вы в форме МЧС.',
  askWhat: 'В письме: даты, маршрут, число людей и контактные лица броней — имя и телефон.',
  sent: 'Письмо с данными выезда принято почтовым сервером и ушло на тестовый ящик Ведара. В МЧС оно не отправлено: заявку подаёте вы — кнопка «Открыть форму МЧС».',
  sentNotLogged: 'Отметка об отправке в журнал не записалась — повторное нажатие может отправить письмо ещё раз.',
  notConfigured: 'Почта на сервере не настроена — письмо не ушло. Данные выезда можно перенести в форму МЧС самим.',
  failed: (reason: string): string => `Письмо не ушло: ${escapeHtml(reason)}. Ничего не отправлено — данные выезда можно перенести в форму МЧС самим.`,
  /** Связь оборвалась или сервер замолчал: на каком шаге — неизвестно, и «ничего не отправлено» было бы догадкой. */
  failedUnsure: 'Почтовый сервер замолчал или оборвал связь: ушло ли письмо, неизвестно. Повторное нажатие может отправить его ещё раз. В МЧС письмо не уходит в любом случае — данные выезда можно перенести в форму МЧС самим.',
  recent: (l: MchsSentLetter, at: string | null): string =>
    `Письмо по этому выезду уже ушло на тестовый ящик Ведара${at ? ` ${at} по Камчатке` : ''}: ${letterContent(l)}. Повторно — не раньше чем через ${Math.round(MCHS_LETTER_REPEAT_MS / 60_000)} минут. В МЧС оно не отправлено.`,
  busy: 'Письмо по этому выезду как раз отправляется — второе не отправляю. Откройте выезд через минуту: там будет видно, ушло ли оно.',
  unchecked: 'Не удалось проверить, отправлялось ли уже письмо по этому выезду, — не отправляю, чтобы не задвоить. Попробуйте позже.',
  ownerOnly: 'Письмо с данными выезда отправляет владелец кабинета — в своём чате. Ничего не отправил.',
  last: (l: MchsSentLetter, at: string | null, gap: MchsLetterGap = 'none'): string =>
    `Письмо (тест) по этому выезду уже уходило на ящик Ведара${at ? ` ${at} по Камчатке` : ''}: ${letterContent(l)}.${GAP_WORDS[gap]} В МЧС — нет.`,
  lastUnchecked: 'Отправлялось ли письмо по этому выезду, сейчас не прочиталось.',
} as const;
