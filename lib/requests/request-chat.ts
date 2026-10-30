/**
 * lib/requests/request-chat.ts — переписка адресата заявки и клиента: правила
 * и тексты без базы и без сети. Запись и доставка —
 * `lib/requests/request-chat-service.ts`.
 *
 * Начиналась с жилья (1349, #2843; слово владельца 29.10: «нужно чтоб с
 * гостем он общался через этот же чат») и стала общей (1350; 30.10, «Единый
 * чат для всех»): заявка на жильё хозяину и любая заявка в `leads`,
 * адресованная партнёру, — туроператору, гиду, перевозчику, прокату. Клиенту —
 * «MAX + страница заявки», телефон клиента адресату остаётся, как был.
 *
 * ── Как ходит сообщение ─────────────────────────────────────────────────────
 *
 * Свободный текст в чате НЕ уходит второй стороне сам. У адресата этот чат —
 * ещё и кабинет: «запиши звонок Анне» там команда CRM, и отправить её клиенту
 * было бы утечкой. У клиента этот чат — Кузьмич. Поэтому сообщение уходит
 * только после кнопки: «Ответить гостю» / «Ответить клиенту» под заявкой
 * (адресат) или «Написать владельцу» / «Написать перевозчику» под ответом
 * (клиент). Кнопка заводит ожидание на `REQUEST_CHAT_WAIT_MIN` минут, и ровно
 * СЛЕДУЮЩЕЕ текстовое сообщение личного диалога уходит по заявке. Одна
 * кнопка — одно сообщение; дальше кнопка появляется снова. «Отмена» гасит
 * ожидание. Слова контроля выхода («вернулся», «задерживаюсь», «иду на …»)
 * ожидание не забирает: их получает контроль, а ожидание гаснет; новая кнопка
 * «Отклонить» под бронью гасит его так же (последняя кнопка — главная).
 *
 * На странице заявки клиент пишет без кнопки: страница и есть переписка.
 *
 * ── ПД ──────────────────────────────────────────────────────────────────────
 *
 * Адресату сообщение клиента уходит с именем клиента — адресат его уже знает
 * из заявки; только в MAX (`sendPdAlert`), в Telegram — заглушка без текста.
 * Клиенту ответ — с названием заявки и именем адресата (вывеска партнёра,
 * публичная), без чужих ПД. Всё, что ввёл человек (текст, желаемые даты),
 * экранируется: текст уходит как HTML. В ленту CRM текст не пишется — только
 * факт сообщения: свободный текст может нести что угодно.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { redactPII } from '@/lib/security/pii-redact';
import { ruDate } from '@/lib/stay/stay-request';

/** Предел длины одного сообщения — тот же, что CHECK в 1349. */
export const REQUEST_CHAT_MAX_LEN = 2000;
/**
 * Сколько ждём текст после кнопки — столько же, сколько ждут причину отказа
 * брони (lib/bookings/chat-owner-action): чем дольше окно, тем вероятнее, что
 * в него попадёт сообщение, написанное уже не клиенту.
 */
export const REQUEST_CHAT_WAIT_MIN = 15;
/** Сколько сообщений клиент может отправить по одной заявке за сутки — защита адресата от потока. */
export const REQUEST_CHAT_GUEST_DAILY_LIMIT = 30;

/** owner — сторона адресата заявки (значение в базе с 1349), guest — клиент. */
export type ChatSide = 'owner' | 'guest';

/** Заявка, по которой идёт переписка: на жильё (stay_requests) или лид (leads). */
export type ChatTargetKind = 'stay' | 'lead';
export interface ChatTarget {
  kind: ChatTargetKind;
  id: string;
}

/**
 * Кнопка в MAX: `sq:o:<id>` / `sq:g:<id>` — заявка на жильё (так её кнопки
 * уходили с 1349, и уже отправленные сообщения должны работать),
 * `lq:o:<id>` / `lq:g:<id>` — лид. `o` — пишет адресат, `g` — клиент.
 */
const PREFIX: Readonly<Record<ChatTargetKind, string>> = { stay: 'sq:', lead: 'lq:' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRESS_RE = new RegExp(`^(sq|lq):([og]):(${UUID})$`, 'i');
const ID_RE = new RegExp(`^${UUID}$`, 'i');

/** id заявки той формы, что разбирает кнопка (uuid); иначе кнопка была бы мёртвой. */
export function isChatTargetId(id: string): boolean {
  return ID_RE.test(id);
}

export function chatPressPayload(side: ChatSide, target: ChatTarget): string {
  return `${PREFIX[target.kind]}${side === 'owner' ? 'o' : 'g'}:${target.id}`;
}

export function isChatPressPayload(payload: string): boolean {
  return payload.startsWith(PREFIX.stay) || payload.startsWith(PREFIX.lead);
}

export function parseChatPress(payload: string): { side: ChatSide; target: ChatTarget } | null {
  const m = PRESS_RE.exec(payload);
  if (!m) return null;
  return {
    side: m[2].toLowerCase() === 'o' ? 'owner' : 'guest',
    target: { kind: m[1].toLowerCase() === 'sq' ? 'stay' : 'lead', id: m[3].toLowerCase() },
  };
}

/**
 * Ссылка «Старт» клиента: `sq_<ключ статуса заявки>` (ключ 1238 — 24 байта в
 * base64url, 32 знака) — для любой заявки с перепиской: ключ сам знает, жильё
 * это или лид. Набранная текстом (web.max.ru не кладёт ?start= в апдейт) — та
 * же форма, можно с «/start ».
 */
export const GUEST_START_PREFIX = 'sq_';

export function guestKeyFromStart(arg: string): string | null {
  const t = arg.trim().replace(/^\/start\s+/i, '');
  if (!t.startsWith(GUEST_START_PREFIX)) return null;
  const key = t.slice(GUEST_START_PREFIX.length);
  return /^[A-Za-z0-9_-]{32}$/.test(key) ? key : null;
}

export function guestBotLink(maxBotLink: string, key: string): string {
  return `${maxBotLink}?start=${GUEST_START_PREFIX}${key}`;
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
  if (text.length > REQUEST_CHAT_MAX_LEN) {
    return { ok: false, error: `Сообщение длиннее ${REQUEST_CHAT_MAX_LEN} знаков — сократите или разбейте на два` };
  }
  return { ok: true, text };
}

// ── Кто адресат ──────────────────────────────────────────────────────────────

export type CounterpartRole = 'stay' | 'operator' | 'guide' | 'carrier' | 'rental' | 'partner';

const ROLE_WORDS: Readonly<Record<CounterpartRole, { title: string; dative: string }>> = {
  stay: { title: 'Владелец', dative: 'владельцу' },
  operator: { title: 'Туроператор', dative: 'туроператору' },
  guide: { title: 'Гид', dative: 'гиду' },
  carrier: { title: 'Перевозчик', dative: 'перевозчику' },
  rental: { title: 'Прокат', dative: 'прокату' },
  partner: { title: 'Партнёр', dative: 'партнёру' },
};

/** Роль адресата словами — по категории партнёра (partners.category). */
export function roleOfCategory(category: string | null | undefined, target: ChatTargetKind): CounterpartRole {
  if (target === 'stay' || category === 'stay') return 'stay';
  switch (category) {
    case 'operator': return 'operator';
    case 'guide': return 'guide';
    case 'transfer': return 'carrier';
    case 'cars':
    case 'gear': return 'rental';
    default: return 'partner';
  }
}

/** Факты заявки для подписи сообщения. ПД клиента здесь нет. */
export interface ChatFacts {
  target: ChatTargetKind;
  /** Объект жилья, тур, маршрут машины — как заявку назвали. */
  title: string;
  /** Даты: у жилья — заезд и выезд, у лида — желаемые даты словами клиента; null — не записаны. */
  dates: string | null;
  people: number | null;
  /** Вывеска адресата (partners.name) — публичная; null — не записана. */
  counterpartName: string | null;
  role: CounterpartRole;
}

export function stayDates(checkIn: string, checkOut: string): string {
  return `${ruDate(checkIn)} — ${ruDate(checkOut)}`;
}

/** Желаемые даты лида — текст клиента: обрезан, экранируется там, где уходит в HTML. */
export function leadDates(raw: string | null | undefined): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/**
 * Даты и люди одной строкой. В заглушку Telegram (`redact`) свободный текст
 * клиента — название направления, желаемые даты — идёт через `redactPII`:
 * туда ПД не уходят, а в поле «куда ехать» человек мог вписать и телефон.
 */
function factsLine(f: ChatFacts, redact = false): string {
  const clean = (v: string) => escapeHtml(redact ? redactPII(v) : v);
  const parts = [
    f.dates ? clean(f.dates) : null,
    f.people != null ? `${f.target === 'stay' ? 'гостей' : 'человек'}: ${f.people}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Название заявки для заглушки Telegram — без ПД. */
function stubTitle(f: ChatFacts): string {
  return escapeHtml(redactPII(f.title));
}

/** Кто клиент для адресата: у жилья — гость, у остальных — клиент. */
function client(f: ChatFacts): { gen: string; nom: string; dat: string } {
  return f.target === 'stay'
    ? { gen: 'гостя', nom: 'Гость', dat: 'гостю' }
    : { gen: 'клиента', nom: 'Клиент', dat: 'клиенту' };
}

function counterpart(f: ChatFacts): string {
  return f.counterpartName ? `${ROLE_WORDS[f.role].title} «${escapeHtml(f.counterpartName)}»` : ROLE_WORDS[f.role].title;
}

/** Адресат словами для экрана (React экранирует сам): «Перевозчик «Шатун»». */
export function counterpartLabel(f: Pick<ChatFacts, 'counterpartName' | 'role'>): string {
  return f.counterpartName ? `${ROLE_WORDS[f.role].title} «${f.counterpartName}»` : ROLE_WORDS[f.role].title;
}

/** Кому пишет клиент — дательный падеж: «владельцу», «перевозчику». */
export function counterpartDative(role: CounterpartRole): string {
  return ROLE_WORDS[role].dative;
}

/** Подписи кнопок: адресату — «Ответить гостю/клиенту», клиенту — «Написать владельцу/перевозчику…». */
export function chatButtonText(side: ChatSide, f: Pick<ChatFacts, 'target' | 'role'>): string {
  if (side === 'owner') return f.target === 'stay' ? 'Ответить гостю' : 'Ответить клиенту';
  return `Написать ${ROLE_WORDS[f.role].dative}`;
}

/**
 * Кнопка адресату под заявкой и под сообщением клиента: «Ответить гостю» /
 * «Ответить клиенту». Действие (payload) — только в MAX: в заглушку Telegram
 * pd-alert кладёт одни ссылки.
 */
export function ownerReplyButton(target: ChatTarget): { text: string; payload: string } {
  return { text: chatButtonText('owner', { target: target.kind, role: 'partner' }), payload: chatPressPayload('owner', target) };
}

/** Адресату: сообщение клиента. С ПД (имя клиента) — только в MAX. */
export function ownerIncomingText(f: ChatFacts, guestName: string, body: string): string {
  const c = client(f);
  return [
    `<b>Сообщение ${c.gen} по заявке: ${escapeHtml(f.title)}</b>`,
    factsLine(f) || null,
    `${c.nom}: ${escapeHtml(guestName)}`,
    '',
    escapeHtml(body),
    '',
    `Ответить в этом чате — кнопка «${chatButtonText('owner', f)}».`,
  ].filter((l) => l !== null).join('\n');
}

/** Адресату в Telegram, если MAX не сработал: без имени и текста. */
export function ownerIncomingStub(f: ChatFacts): string {
  const c = client(f);
  return [
    `<b>Сообщение ${c.gen} по заявке: ${stubTitle(f)}</b>`,
    factsLine(f, true) || null,
    `Текст и имя ${c.gen} в Telegram не передаются. Чтобы переписываться, подключите MAX: ссылку на бота пришлёт администратор Ведара.`,
  ].filter((l) => l !== null).join('\n');
}

/** Оператору платформы, если адресату сообщение не дошло: передать вручную. */
export function platformIncomingText(f: ChatFacts, guestName: string, body: string, why: string): string {
  const c = client(f);
  return [
    `<b>Сообщение ${c.gen} не дошло до адресата: ${escapeHtml(f.title)}</b>`,
    `Адресат: ${counterpart(f)}`,
    factsLine(f) || null,
    `${c.nom}: ${escapeHtml(guestName)}`,
    `Причина: ${escapeHtml(why)}`,
    '',
    escapeHtml(body),
  ].filter((l) => l !== null).join('\n');
}

export function platformIncomingStub(f: ChatFacts): string {
  const c = client(f);
  return [
    `<b>Сообщение ${c.gen} не дошло до адресата: ${stubTitle(f)}</b>`,
    `Адресат: ${counterpart(f)}`,
    'MAX не сработал: текст — в админке, у заявки (раздел «Переписка»).',
  ].join('\n');
}

/** Клиенту: ответ адресата. ПД клиента здесь нет. */
export function guestIncomingText(f: ChatFacts, body: string): string {
  return [
    `<b>Ответ: ${counterpart(f)}</b>`,
    `По вашей заявке «${escapeHtml(f.title)}»${f.dates ? `, ${escapeHtml(f.dates)}` : ''}`,
    '',
    escapeHtml(body),
    '',
    `Ответить — кнопка «${chatButtonText('guest', f)}».`,
  ].join('\n');
}

/** Ответ на кнопку: что делать дальше. */
export function waitPrompt(side: ChatSide, f: ChatFacts | null): string {
  const about = f ? ` по заявке «${escapeHtml(f.title)}»${f.dates ? `, ${escapeHtml(f.dates)}` : ''}` : '';
  const whom = side === 'owner'
    ? `ответ ${f ? client(f).dat : 'клиенту'}`
    : `сообщение ${f ? ROLE_WORDS[f.role].dative : 'адресату'}`;
  return `Напишите ${whom}${about} одним сообщением — я передам его. «Отмена» — не отправлять. Ждём ${REQUEST_CHAT_WAIT_MIN} минут.`;
}

export type ChatDelivery = 'max' | 'no_address' | 'failed';

/**
 * Что ещё известно об отправке, кроме канала:
 *  - `relayed` — сообщение клиента, не дошедшее до адресата, получил оператор
 *    Ведара; false — не получил и он (ни MAX, ни рабочий чат не ответили);
 *  - `pageVisible` — у клиента есть живая ссылка на переписку; false — ответ
 *    адресата клиенту прочитать негде.
 */
export interface DeliveryFacts {
  relayed?: boolean;
  pageVisible?: boolean;
}

/** Итог отправки — тому, кто писал. «Не дошло» не выдаётся за «отправлено» (§4.0). */
export function sentReplyText(
  side: ChatSide, delivery: ChatDelivery, f: Pick<ChatFacts, 'target' | 'role'>, more: DeliveryFacts = {},
): string {
  if (side === 'owner') {
    const dat = f.target === 'stay' ? 'гостю' : 'клиенту';
    const gen = f.target === 'stay' ? 'гостя' : 'клиента';
    const nom = f.target === 'stay' ? 'гость' : 'клиент';
    if (delivery === 'max') return `Передал ${dat} в MAX. Ответ ${gen} придёт сюда.`;
    if (more.pageVisible === false) {
      return `Записал, но прочитать ${dat} это негде: MAX ${nom} не подключил, а ссылки на переписку у него нет. Позвоните по телефону из заявки.`;
    }
    return delivery === 'no_address'
      ? `Записал на странице заявки ${gen}: MAX ${nom} пока не подключил — сообщение он увидит, когда откроет страницу. Если ответ срочный — позвоните по телефону из заявки.`
      : `Записал на странице заявки ${gen}, но в MAX передать не удалось. Если ответ срочный — позвоните по телефону из заявки.`;
  }
  const dat = ROLE_WORDS[f.role].dative;
  if (delivery === 'max') return `Передал ${dat}. Ответ придёт сюда и появится на странице заявки.`;
  if (more.relayed === false) {
    return `Сообщение записано на странице заявки, но передать его сейчас не удалось — ни ${dat}, ни оператору Ведара. Попробуйте ещё раз позже.`;
  }
  return delivery === 'no_address'
    ? `${ROLE_WORDS[f.role].title} пока не подключил MAX: сообщение получил оператор Ведара и передаст его.`
    : `Передать ${dat} сразу не удалось — сообщение получил оператор Ведара и передаст его.`;
}

/** Адресату на кнопку, если клиенту ответ прочитать негде. */
export function noPlaceToReadText(f: Pick<ChatFacts, 'target'>): string {
  const [dat, nom] = f.target === 'stay' ? ['гостю', 'гость'] : ['клиенту', 'клиент'];
  return `Ответ ${dat} прочитать негде: MAX ${nom} не подключил, а ссылки на переписку у него нет. Позвоните по телефону из заявки — ничего не отправлено.`;
}

/** Добавка к ответу на кнопку, если она сняла ожидание причины отказа брони. */
export const REASON_SUPERSEDED_NOTE = 'Ожидание причины отклонения брони снято: чтобы отклонить бронь, нажмите «Отклонить» под ней ещё раз.';

export const CHAT_TEXT = {
  cancelled: 'Не отправляю. Чтобы написать, нажмите кнопку под сообщением ещё раз.',
  expired: 'Ожидание истекло — сообщение не отправлено. Нажмите кнопку под сообщением ещё раз.',
  notYoursOwner: 'Эта заявка адресована не вам — ответить на неё отсюда нельзя.',
  notYoursGuest: 'Эта заявка не подключена к этому чату — написать по ней отсюда нельзя. Откройте страницу заявки по ссылке, которую получили.',
  notFound: 'Заявка не найдена — возможно, её удалили.',
  noCounterpart: 'У этой заявки нет адресата, которому можно написать: её ведёт менеджер Ведара.',
  unchecked: 'Не удалось проверить заявку — база не ответила. Попробуйте через минуту, ничего не отправлено.',
  saveFailed: 'Сообщение не записалось — сбой на нашей стороне. Попробуйте ещё раз через минуту.',
  dailyLimit: `По этой заявке за сутки уже ${REQUEST_CHAT_GUEST_DAILY_LIMIT} сообщений — дальше лучше позвонить.`,
  bindNotFound: 'Заявка по этой ссылке не найдена или ссылка истекла. Откройте ссылку со страницы заявки целиком.',
  bindAlreadyBound: 'К этой заявке уже подключён другой чат MAX. Переписка доступна на странице заявки.',
  bindNoChat: 'По этой ссылке переписки нет — только состояние заявки, на её странице. Если вы уже отправляли эту заявку раньше, подключите MAX ссылкой, выданной в первый раз.',
  bindDbError: 'Не удалось подключить чат — база не ответила. Попробуйте открыть ссылку через минуту.',
} as const;

/** Клиенту после «Старта» по ссылке заявки. */
export function guestBoundText(f: ChatFacts, ownerMessages: number): string {
  const head = `Готово: ответы по заявке «${escapeHtml(f.title)}» (${counterpart(f)}) будут приходить сюда.`;
  const tail = ownerMessages > 0
    ? ' Уже есть ответ — сообщения ниже.'
    : ` Написать — кнопка «${chatButtonText('guest', f)}».`;
  return head + tail;
}
