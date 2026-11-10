/**
 * «Регистрация в МЧС» в чате — тексты и правила, без базы и сети.
 *
 * Слово владельца 10.11: «в форму гида и оператора и просто туриста в чате
 * добавить кнопку регистрация в мчс и продумать схему работы». Схема —
 * docs/safety/MCHS_CHAT_SCHEME.md. Коротко:
 *
 *  - Ведар заявку в МЧС сам не подаёт (решение владельца 30.09,
 *    lib/safety/mchs-form-text): её подаёт руководитель группы на сайте МЧС.
 *    Кнопка в чате называет срок, показывает, по каким выездам он ещё
 *    выдерживается, и собирает данные выезда одним текстом для формы.
 *  - Слова «зарегистрировано» здесь нет и быть не может: регистрирует МЧС, и
 *    ответа ведомства Ведар не видит (§0, §4.0).
 *  - Факты (срок, ссылка, каналы, перечень данных) — только из
 *    lib/safety/mchs-registration; здесь они не повторяются числом.
 *  - Имена и телефоны туристов — только в MAX (решение владельца 23.08);
 *    в Telegram текст выезда собирается без них.
 *
 * Турист в чате ничего не вводит: кнопка отвечает правилом и ссылками, данные
 * группы человек собирает на странице /register сайта.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import {
  MCHS_CHANNELS, MCHS_DEADLINE_SHORT, MCHS_ONLINE_FORM_URL, MCHS_REQUIRED_DATA,
  MCHS_SOURCE, registrationVerdict, type MchsVerdict,
} from '@/lib/safety/mchs-registration';

/** Подпись кнопки — одна на три роли и два мессенджера. */
export const MCHS_CHAT_BUTTON = 'Регистрация в МЧС';

/** Payload кнопки туриста в MAX (стартовое меню). Кнопка без последствий: только ответ. */
export const MCHS_TOURIST_PAYLOAD = 'mchs_info';

/** На сколько дней вперёд кабинет показывает выезды. */
export const MCHS_WINDOW_DAYS = 60;

/** Сколько выездов получают кнопку: дальше — кабинет на сайте. */
export const MCHS_LIST_MAX = 8;

/** Сколько контактных лиц несёт текст выезда: сообщение мессенджера не резиновое. */
export const MCHS_CONTACTS_MAX = 25;

/** Кто подаёт и чего Ведар не делает — одна фраза на все экраны. */
export const MCHS_WHO_SUBMITS =
  'Ведар заявку в МЧС сам не подаёт и ответа МЧС не видит: её подаёт руководитель группы.';

const SOURCE_LINE = `Сведения: ${MCHS_SOURCE.authority}, ${MCHS_SOURCE.asOf}.`;

function ruDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ymd;
}

function ruDayMonth(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}.${m[2]}` : ymd;
}

// ── Турист ──────────────────────────────────────────────────────────────────

/** Ответ туристу на кнопку (HTML). Ничего не спрашивает и не записывает. */
export function mchsTouristText(): string {
  const lines = [
    `<b>${MCHS_CHAT_BUTTON}</b>`,
    `Идёте сами, без оператора — заявку в МЧС подаёт руководитель вашей группы. ${MCHS_DEADLINE_SHORT}.`,
    'Идёте с оператором или гидом — группу регистрирует он. Спросите у него, подана ли заявка.',
    '',
    'Что указать в заявке:',
    ...MCHS_REQUIRED_DATA.map((d) => `— ${d}`),
    '',
    'Как подать:',
    ...MCHS_CHANNELS.map((c) => `— ${c.title}. ${c.detail}${c.key === 'online' ? ' — кнопка ниже' : ''}.`),
    '',
    `${MCHS_WHO_SUBMITS} На сайте Ведара можно собрать данные группы одним текстом для формы — кнопка «Собрать данные».`,
    SOURCE_LINE,
    'В беде — 112.',
  ];
  return lines.join('\n');
}

/** Ссылки под ответом туристу: официальная форма и страница сбора данных на сайте. */
export function mchsTouristLinks(base: string): Array<{ text: string; url: string }> {
  return [
    { text: 'Форма МЧС', url: MCHS_ONLINE_FORM_URL },
    { text: 'Собрать данные', url: `${base.replace(/\/$/, '')}/register` },
  ];
}

// ── Оператор и гид ──────────────────────────────────────────────────────────

/**
 * Что запись маршрута говорит о регистрации. Три исхода (§4.0): `false` в
 * базе — «не отмечено», а не «не нужна»; маршрута у тура нет — «не знаем».
 */
export type MchsRequirement = 'required' | 'not_marked' | 'no_route';

export function mchsRequirementOf(routeLinked: boolean, required: boolean | null): MchsRequirement {
  if (!routeLinked) return 'no_route';
  return required === true ? 'required' : 'not_marked';
}

export const MCHS_REQUIREMENT_TEXT: Readonly<Record<MchsRequirement, string>> = {
  required: 'Маршрут требует регистрации в МЧС.',
  not_marked: 'В записи маршрута требование не отмечено — это не значит, что регистрация не нужна.',
  no_route: 'Маршрут к туру не привязан — нужна ли регистрация, в записи Ведара нет.',
};

/** Выезд: брони тура на дату, без имён. */
export interface MchsDeparture {
  date: string;
  endDate: string;
  tourId: string;
  title: string;
  people: number;
  bookings: number;
  routeTitle: string | null;
  required: boolean | null;
  mchsPhone: string | null;
}

/** Контактное лицо брони — только для MAX. */
export interface MchsBookingContact {
  name: string | null;
  phone: string | null;
  participants: number;
}

export interface MchsGroup extends MchsDeparture {
  /** null — контакты не запрашивались (Telegram): их нет и в памяти. */
  contacts: MchsBookingContact[] | null;
}

/**
 * Срок по выезду: исход и строка. Оба дня — календарные дни Камчатки: утром
 * по Камчатке в UTC ещё вчера, и счёт от даты UTC дал бы лишний рабочий день —
 * «впритык» там, где срок уже не выдержать.
 */
export function mchsDeadlineOf(date: string, nowMs: number): { verdict: MchsVerdict; text: string } {
  const today = kamchatkaDate(new Date(nowMs));
  const v = registrationVerdict(new Date(`${date}T00:00:00Z`), new Date(`${today}T00:00:00Z`));
  return { verdict: v.verdict, text: v.text };
}

function peopleWord(n: number): string {
  return `${n} чел.`;
}

/** Две строки о выезде в списке: что за выезд и что со сроком. */
export function mchsDepartureLines(d: MchsDeparture, nowMs: number): string[] {
  const req = mchsRequirementOf(d.routeTitle !== null, d.required);
  return [
    `<b>${ruDayMonth(d.date)}</b> · ${escapeHtml(d.title)} — ${peopleWord(d.people)}`,
    `${MCHS_REQUIREMENT_TEXT[req]} ${mchsDeadlineOf(d.date, nowMs).text}`,
  ];
}

/** Чего в записи брони нет, а форма МЧС спрашивает. */
export const MCHS_GROUP_NOT_IN_RECORD: readonly string[] = [
  'ФИО, адреса и телефоны всех участников',
  'руководитель группы и его телефон',
  'время и способ сеансов связи (спутниковый телефон, рация, график)',
  'средства передвижения',
  'места ночлега по дням',
];

/**
 * Данные выезда одним текстом для формы МЧС (HTML: всё введённое людьми
 * экранировано). `contacts === null` — без имён и телефонов.
 */
export function mchsGroupText(g: MchsGroup, nowMs: number, opts: { allContacts?: boolean } = {}): string {
  // Сообщение чата не резиновое — там предел; письмо несёт всех (lib/safety/mchs-letter-text).
  const contactsMax = opts.allContacts ? Number.POSITIVE_INFINITY : MCHS_CONTACTS_MAX;
  const req = mchsRequirementOf(g.routeTitle !== null, g.required);
  const lines: string[] = [
    'Регистрация туристской группы — Камчатский край',
    `Даты: ${ruDate(g.date)} — ${ruDate(g.endDate)}`,
    g.routeTitle !== null
      ? `Маршрут: ${escapeHtml(g.routeTitle)} (тур «${escapeHtml(g.title)}»)`
      : `Маршрут: к туру «${escapeHtml(g.title)}» в записи Ведара не привязан — опишите в форме`,
    `Группа: ${peopleWord(g.people)}, броней — ${g.bookings}`,
  ];
  if (g.contacts !== null) {
    lines.push('Контактные лица по броням:');
    g.contacts.slice(0, contactsMax).forEach((c, i) => {
      const bits = [escapeHtml((c.name ?? '').trim() || 'имя не записано')];
      if ((c.phone ?? '').trim()) bits.push(`тел. ${escapeHtml((c.phone ?? '').trim())}`);
      bits.push(peopleWord(c.participants));
      lines.push(`${i + 1}. ${bits.join(', ')}`);
    });
    if (g.contacts.length > contactsMax) {
      lines.push(`…и ещё ${g.contacts.length - contactsMax} — в кабинете на сайте.`);
    }
    lines.push('Имён остальных участников в записи Ведара нет.');
  }
  lines.push('');
  lines.push(`В записи Ведара этого нет — заполните в форме МЧС: ${MCHS_GROUP_NOT_IN_RECORD.join('; ')}.`);
  lines.push(`${MCHS_REQUIREMENT_TEXT[req]} ${mchsDeadlineOf(g.date, nowMs).text}`);
  if ((g.mchsPhone ?? '').trim()) lines.push(`Телефон МЧС из записи маршрута: ${escapeHtml((g.mchsPhone ?? '').trim())}.`);
  lines.push(`${MCHS_DEADLINE_SHORT}. ${MCHS_WHO_SUBMITS}`);
  return lines.join('\n');
}

export const MCHS_CHAT_TEXT = {
  listHead: `<b>${MCHS_CHAT_BUTTON}</b>`,
  listRule: `${MCHS_DEADLINE_SHORT}. ${MCHS_WHO_SUBMITS} Нажмите выезд — соберу его данные одним текстом для формы МЧС.`,
  listEmpty: `Выездов с подтверждёнными бронями на ближайшие ${MCHS_WINDOW_DAYS} дней нет. Форма МЧС — кнопкой ниже.`,
  listFailed: `Выезды не прочитались — сбой на нашей стороне. ${MCHS_DEADLINE_SHORT}; форма МЧС — кнопкой ниже.`,
  groupHead: '<b>Данные для формы МЧС</b> — скопируйте сообщение и перенесите в форму.',
  groupGone: 'Выезда с подтверждёнными бронями на эту дату нет — возможно, бронь отменена.',
  groupFailed: 'Выезд не прочитался — сбой на нашей стороне. Ничего не изменено.',
  groupNoContactsTelegram: 'Имена и телефоны туристов в Telegram не показываются — состав группы в MAX или в кабинете на сайте.',
  notForRole: 'Регистрация в МЧС в кабинете чата — у туроператора и гида: у них выезды с группами.',
} as const;
