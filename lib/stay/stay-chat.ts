/**
 * lib/stay/stay-chat.ts — переписка хозяина жилья и гостя по заявке (1348,
 * #2843): правила и тексты без базы и без сети. Запись и доставка —
 * `lib/stay/stay-chat-service.ts`.
 *
 * Слово владельца 29.10: «нужно чтоб с гостем он общался через этот же чат»
 * — то есть в чате MAX, куда хозяину приходит заявка. Гостю — «MAX +
 * страница заявки», телефон гостя хозяину остаётся, как был.
 *
 * ── Как ходит сообщение ─────────────────────────────────────────────────────
 *
 * Свободный текст в чате НЕ уходит второй стороне сам. У хозяина этот чат —
 * ещё и кабинет: «запиши звонок Анне» там команда CRM, и отправить её гостю
 * было бы утечкой. У гостя этот чат — Кузьмич. Поэтому сообщение уходит
 * только после кнопки: «Ответить гостю» под заявкой (хозяин) или «Написать
 * владельцу» под ответом (гость). Кнопка заводит ожидание на
 * `STAY_CHAT_WAIT_MIN` минут, и ровно СЛЕДУЮЩЕЕ текстовое сообщение личного
 * диалога уходит по заявке. Одна кнопка — одно сообщение; дальше кнопка
 * появляется снова. «Отмена» гасит ожидание.
 *
 * На странице заявки гость пишет без кнопки: страница и есть переписка.
 *
 * ── ПД ──────────────────────────────────────────────────────────────────────
 *
 * Хозяину сообщение гостя уходит с именем гостя — хозяин его уже знает из
 * заявки; только в MAX (`sendPdAlert`), в Telegram — заглушка без текста.
 * Гостю ответ хозяина — с названием объекта и датами, без чужих ПД. Всё, что
 * ввёл человек, экранируется: текст уходит как HTML. В ленту CRM текст не
 * пишется — только факт сообщения: свободный текст может нести что угодно.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { ruDate } from '@/lib/stay/stay-request';

/** Предел длины одного сообщения — тот же, что CHECK в 1348. */
export const STAY_CHAT_MAX_LEN = 2000;
/** Сколько ждём текст после кнопки. */
export const STAY_CHAT_WAIT_MIN = 30;
/** Сколько сообщений гость может отправить по одной заявке за сутки — защита хозяина от потока. */
export const STAY_CHAT_GUEST_DAILY_LIMIT = 30;

export type StayChatSide = 'owner' | 'guest';

/** Кнопка в MAX: `sq:o:<id>` — хозяин отвечает гостю, `sq:g:<id>` — гость пишет хозяину. */
const PRESS_PREFIX = 'sq:';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRESS_RE = new RegExp(`^sq:([og]):(${UUID})$`, 'i');

export function stayChatPressPayload(side: StayChatSide, requestId: string): string {
  return `${PRESS_PREFIX}${side === 'owner' ? 'o' : 'g'}:${requestId}`;
}

export function isStayChatPressPayload(payload: string): boolean {
  return payload.startsWith(PRESS_PREFIX);
}

export function parseStayChatPress(payload: string): { side: StayChatSide; requestId: string } | null {
  const m = PRESS_RE.exec(payload);
  if (!m) return null;
  return { side: m[1].toLowerCase() === 'o' ? 'owner' : 'guest', requestId: m[2].toLowerCase() };
}

/**
 * Ссылка «Старт» гостя: `sq_<ключ статуса заявки>` (ключ 1238 — 24 байта в
 * base64url, 32 знака). Набранная текстом (web.max.ru не кладёт ?start= в
 * апдейт) — та же форма, можно с «/start ».
 */
export const STAY_GUEST_START_PREFIX = 'sq_';

export function stayKeyFromStart(arg: string): string | null {
  const t = arg.trim().replace(/^\/start\s+/i, '');
  if (!t.startsWith(STAY_GUEST_START_PREFIX)) return null;
  const key = t.slice(STAY_GUEST_START_PREFIX.length);
  return /^[A-Za-z0-9_-]{32}$/.test(key) ? key : null;
}

export function stayGuestBotLink(maxBotLink: string, key: string): string {
  return `${maxBotLink}?start=${STAY_GUEST_START_PREFIX}${key}`;
}

/** «отмена», «не надо», «/cancel» — погасить ожидание без отправки. */
const CANCEL_RE = /^(\/cancel|отмена|отменить|не надо|не отправляй|стоп)[.!]?$/i;

export function isCancelText(text: string): boolean {
  return CANCEL_RE.test(text.trim().replace(/\s+/g, ' '));
}

/**
 * Текст сообщения: управляющие знаки вон (кроме перевода строки), края
 * обрезаны. Пустое и длиннее предела — отказ со словами для человека.
 */
export function normalizeChatText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Сообщение пустое' };
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  if (!text) return { ok: false, error: 'Сообщение пустое' };
  if (text.length > STAY_CHAT_MAX_LEN) {
    return { ok: false, error: `Сообщение длиннее ${STAY_CHAT_MAX_LEN} знаков — сократите или разбейте на два` };
  }
  return { ok: true, text };
}

/** Факты заявки для подписи сообщения. */
export interface StayChatRequestFacts {
  accommodationName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
}

function datesLine(f: StayChatRequestFacts): string {
  return `${ruDate(f.checkIn)} — ${ruDate(f.checkOut)}`;
}

/** Хозяину: сообщение гостя. С ПД (имя гостя) — только в MAX. */
export function ownerIncomingText(f: StayChatRequestFacts, guestName: string, body: string): string {
  return [
    `<b>Сообщение гостя по заявке: ${escapeHtml(f.accommodationName)}</b>`,
    `${datesLine(f)} · гостей: ${f.guests}`,
    `Гость: ${escapeHtml(guestName)}`,
    '',
    escapeHtml(body),
    '',
    'Ответить в этом чате — кнопка «Ответить гостю».',
  ].join('\n');
}

/** Хозяину в Telegram, если MAX не сработал: без имени и текста. */
export function ownerIncomingStub(f: StayChatRequestFacts): string {
  return [
    `<b>Сообщение гостя по заявке: ${escapeHtml(f.accommodationName)}</b>`,
    `${datesLine(f)} · гостей: ${f.guests}`,
    'Текст и имя гостя в Telegram не передаются. Чтобы переписываться с гостем, подключите MAX: ссылку на бота пришлёт администратор Ведара.',
  ].join('\n');
}

/** Оператору платформы, если хозяину сообщение не дошло: передать вручную. */
export function platformIncomingText(f: StayChatRequestFacts, guestName: string, body: string, why: string): string {
  return [
    `<b>Сообщение гостя не дошло до владельца: ${escapeHtml(f.accommodationName)}</b>`,
    `${datesLine(f)} · гостей: ${f.guests}`,
    `Гость: ${escapeHtml(guestName)}`,
    `Причина: ${escapeHtml(why)}`,
    '',
    escapeHtml(body),
  ].join('\n');
}

export function platformIncomingStub(f: StayChatRequestFacts): string {
  return [
    `<b>Сообщение гостя не дошло до владельца: ${escapeHtml(f.accommodationName)}</b>`,
    `${datesLine(f)} · гостей: ${f.guests}`,
    'MAX не сработал: текст — в админке, Жильё → «Заявки гостей».',
  ].join('\n');
}

/** Гостю: ответ хозяина. ПД гостя здесь нет; телефон объекта — на карточке. */
export function guestIncomingText(f: StayChatRequestFacts, body: string): string {
  return [
    `<b>Ответ владельца: ${escapeHtml(f.accommodationName)}</b>`,
    `По вашей заявке на ${datesLine(f)}`,
    '',
    escapeHtml(body),
    '',
    'Ответить владельцу — кнопка «Написать владельцу».',
  ].join('\n');
}

export const STAY_CHAT_BUTTON: Record<StayChatSide, string> = {
  owner: 'Ответить гостю',
  guest: 'Написать владельцу',
};

/** Ответ на кнопку: что делать дальше. */
export function waitPrompt(side: StayChatSide, f: StayChatRequestFacts | null): string {
  const about = f ? ` по заявке «${escapeHtml(f.accommodationName)}», ${datesLine(f)}` : '';
  return side === 'owner'
    ? `Напишите ответ гостю${about} одним сообщением — я передам его. «Отмена» — не отправлять. Ждём ${STAY_CHAT_WAIT_MIN} минут.`
    : `Напишите сообщение владельцу${about} одним сообщением — я передам его. «Отмена» — не отправлять. Ждём ${STAY_CHAT_WAIT_MIN} минут.`;
}

export type StayChatDelivery = 'max' | 'no_address' | 'failed';

/** Итог отправки — тому, кто писал. «Не дошло» не выдаётся за «отправлено» (§4.0). */
export function sentReplyText(side: StayChatSide, delivery: StayChatDelivery): string {
  if (side === 'owner') {
    switch (delivery) {
      case 'max': return 'Передал гостю в MAX. Ответ гостя придёт сюда.';
      case 'no_address': return 'Записал на странице заявки гостя: MAX гость пока не подключил, и сообщение он увидит там. Если ответ срочный — позвоните по телефону из заявки.';
      default: return 'Записал на странице заявки гостя, но в MAX передать не удалось. Если ответ срочный — позвоните по телефону из заявки.';
    }
  }
  switch (delivery) {
    case 'max': return 'Передал владельцу. Его ответ придёт сюда и появится на странице заявки.';
    case 'no_address': return 'Владелец пока не подключил MAX: сообщение получил оператор Ведара и передаст его. Срочно — звоните владельцу, телефон на карточке объекта.';
    default: return 'Сообщение записано, но владельцу его передать не удалось — оператор Ведара получил его и передаст. Срочно — звоните владельцу, телефон на карточке объекта.';
  }
}

export const STAY_CHAT_TEXT = {
  cancelled: 'Не отправляю. Чтобы написать, нажмите кнопку под сообщением ещё раз.',
  expired: 'Ожидание истекло — сообщение не отправлено. Нажмите кнопку под сообщением ещё раз.',
  notYoursOwner: 'Эта заявка не к вашему объекту — ответить на неё отсюда нельзя.',
  notYoursGuest: 'Эта заявка не подключена к этому чату — написать по ней отсюда нельзя. Откройте страницу заявки по ссылке, которую получили.',
  notFound: 'Заявка не найдена — возможно, её удалили.',
  unchecked: 'Не удалось проверить заявку — база не ответила. Попробуйте через минуту, ничего не отправлено.',
  saveFailed: 'Сообщение не записалось — сбой на нашей стороне. Попробуйте ещё раз через минуту.',
  dailyLimit: `По этой заявке за сутки уже ${STAY_CHAT_GUEST_DAILY_LIMIT} сообщений — дальше звоните владельцу: телефон на карточке объекта.`,
  bindNotFound: 'Заявка по этой ссылке не найдена или ссылка истекла. Откройте ссылку со страницы заявки целиком.',
  bindAlreadyBound: 'К этой заявке уже подключён другой чат MAX. Переписка доступна на странице заявки.',
  bindDbError: 'Не удалось подключить чат — база не ответила. Попробуйте открыть ссылку через минуту.',
} as const;

/** Гостю после «Старта» по ссылке заявки. */
export function guestBoundText(f: StayChatRequestFacts, ownerMessages: number): string {
  const head = `Готово: ответы владельца «${escapeHtml(f.accommodationName)}» по заявке на ${datesLine(f)} будут приходить сюда.`;
  const tail = ownerMessages > 0
    ? ` Владелец уже ответил — сообщения ниже.`
    : ' Написать владельцу — кнопка ниже.';
  return head + tail;
}
