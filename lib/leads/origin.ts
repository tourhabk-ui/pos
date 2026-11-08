/**
 * lib/leads/origin.ts — откуда пришла заявка: кто её отправил (человек или
 * ИИ-агент) и каким путём. Одно правило для админского списка, карточки
 * лида у оператора, уведомления админу и строки «Откуда» партнёру.
 *
 * Слово владельца 08.11: «нужно писать, откуда лиды — человек или ИИ и через
 * какой инструмент: ТГ, MAX, MCP, A2A или на сайте Кузьмич». До этого:
 *   - заявки из чата Кузьмича (сайт, Telegram, MAX) и через A2A записывались
 *     как `source: 'mcp'` — их создают те же функции, что у MCP;
 *   - подписей было три разных словаря, а карточка оператора показывала
 *     сырой адрес вроде `mcp://vedar/booking`.
 *
 * Что знаем — из записанного, чего не знаем — так и сказано (§4.0):
 *   1. `source_data.entry` — вход, записанный при создании заявки (с 08.11,
 *      lib/leads/entry-context);
 *   2. старые заявки через инструменты Ведара — след согласия
 *      (`pd_consent_source`): чат Кузьмича пишет свой канал с 06.11, ИИ-агент —
 *      `mcp`, а после подтверждения человеком на странице заявки —
 *      `request-page`. До 06.11 и чат писал `mcp`, поэтому раньше отсечки
 *      агента от чата не отличить; MCP от A2A у старых заявок не отличить ничем;
 *   3. формы сайта и боты — `source_data.source`;
 *   4. форма без источника — по адресу страницы;
 *   5. остальное — «не записано», а не догадка.
 *
 * Модуль чистый: без базы и Node API.
 */

import { asLeadEntry, type LeadEntry } from '@/lib/leads/entry-values';

export type LeadActor = 'human' | 'agent';

export interface LeadOriginInput {
  source_url?: string | null;
  source_data?: Record<string, unknown> | null;
  /** Канал согласия: для старых заявок через инструменты — единственный след входа. */
  pd_consent_source?: string | null;
  /** Когда создана: нужна только старым заявкам через инструменты (отсечка 06.11). */
  created_at?: string | Date | null;
}

export interface LeadOrigin {
  /** null — кто отправил, не записано. */
  actor: LeadActor | null;
  /** Путь словами: «MCP», «Кузьмич в Telegram», «сайт, планер поездки». */
  via: string;
  /** Что за заявка — у заявок через инструменты Ведара: «заявка на тур». */
  what: string | null;
  /** Одна строка для экрана и уведомления. */
  label: string;
}

/**
 * Согласие, заявленное агентом, и подтверждение человеком на странице заявки
 * (lib/mcp/request-status: AGENT_CONSENT_SOURCE, HUMAN_CONSENT_SOURCE). Здесь
 * литералами: тот модуль тянет базу, а этот читают и клиентские экраны.
 * Равенство держит сторож tests/unit/lead-origin.test.ts.
 */
export const AGENT_CONSENT = 'mcp';
export const HUMAN_CONFIRMED_CONSENT = 'request-page';

/**
 * С какого момента чат Кузьмича пишет согласие своим каналом (kuzmich-*).
 * PR #3070 выкатился 06.11 в 10:29 UTC (deploy.yml, прогон 3055, ff066c3c9);
 * до того согласие из чата писалось как `mcp`, то есть как у ИИ-агента.
 * Отсечка взята с запасом — полдень UTC: раньше неё `mcp` у заявки значит
 * «агент или чат», а не «агент».
 */
export const CHAT_CONSENT_RECORDED_SINCE = '2026-11-06T12:00:00Z';

const ENTRY_WORDS: Record<LeadEntry, { actor: LeadActor; via: string }> = {
  mcp: { actor: 'agent', via: 'MCP' },
  a2a: { actor: 'agent', via: 'A2A' },
  'kuzmich-web': { actor: 'human', via: 'Кузьмич на сайте' },
  'kuzmich-tg': { actor: 'human', via: 'Кузьмич в Telegram' },
  'kuzmich-max': { actor: 'human', via: 'Кузьмич в MAX' },
};

const TOOL_WORDS: Record<string, string> = {
  create_booking_request: 'заявка на тур',
  create_lead: 'подбор тура',
  request_charter: 'машина под заказ',
  create_car_rental_request: 'прокат машины',
  create_trip_request: 'поездка целиком',
};

/** Формы сайта и боты: `source_data.source` → путь словами. Пишет человек. */
const SOURCE_WORDS: Record<string, string> = {
  telegram_bot: 'Telegram-бот Кузьмича',
  telegram_lead_flow: 'Telegram-бот Кузьмича, форма заявки',
  max_bot: 'MAX-бот Кузьмича',
  booking_intake_bot: 'чат приёма заявок на сайте',
  request_page: 'сайт, страница заявки',
  trip_planner: 'сайт, планер поездки',
  saved_trip: 'сайт, сохранённая поездка',
  website: 'сайт, страница контактов',
  homepage_cta: 'сайт, главная',
  route_page: 'сайт, страница маршрута',
  operator_page: 'сайт, страница компании',
  partner_widget: 'виджет на сайте партнёра',
  partner_site: 'сайт партнёра',
  transfer_page: 'сайт, страница перевозчика',
  car_rental_page: 'сайт, страница проката',
};

const ACTOR_WORDS: Record<LeadActor, string> = { human: 'Человек', agent: 'ИИ-агент' };

/** Подпись, когда о происхождении не записано ничего. */
export const ORIGIN_NOT_RECORDED = 'не записано';

/** Хосты сайта Ведара: их страница — «сайт, /путь»; чужая — со своим хостом. */
const OWN_HOSTS = new Set(['vedarai.ru', 'www.vedarai.ru']);

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function origin(actor: LeadActor | null, via: string, what: string | null): LeadOrigin {
  const who = actor ? ACTOR_WORDS[actor] : 'Кто отправил — не записано';
  return { actor, via, what, label: [who, via, what].filter(Boolean).join(' · ') };
}

/** Длинный адрес — укорочен: подпись не должна раздувать карточку. */
function short(s: string): string {
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/**
 * Адрес страницы, с которой отправлена форма: полный или путь сайта. Адрес
 * инструмента (`mcp://…`) и прочее — не страница, null.
 */
export function leadPageUrl(sourceUrl: string | null | undefined): string | null {
  const url = text(sourceUrl);
  return /^https?:\/\/|^\//i.test(url) ? url : null;
}

/** Путь своего сайта словами: корень — «главная», остальное — сам путь. */
function sitePathWords(path: string): string {
  return path === '/' || path === '' ? 'сайт, главная' : `сайт, ${short(path)}`;
}

/**
 * Страница словами: «сайт, /routes/abc» или «страница partner.ru/tours».
 * Строка запроса и якорь отброшены: адрес присылает форма, и в хвосте бывает
 * что угодно — метки, ключи, свободный ввод.
 */
function pageWords(page: string): string {
  const m = /^https?:\/\/([^/?#]+)(.*)$/i.exec(page);
  if (!m) return sitePathWords(page.replace(/[?#].*$/, ''));
  // Логин и пароль в адресе (user:pass@host) — не часть страницы.
  const host = m[1].toLowerCase().replace(/^.*@/, '');
  const path = m[2].replace(/[?#].*$/, '') || '/';
  return OWN_HOSTS.has(host) ? sitePathWords(path) : `страница ${short(host.replace(/^www\./, '') + path)}`;
}

/** Создана ли заявка не раньше `since`. Нет даты или она не читается — нет. */
function createdSince(at: LeadOriginInput['created_at'], since: string): boolean {
  if (at === null || at === undefined) return false;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) && t >= Date.parse(since);
}

export function leadOrigin(input: LeadOriginInput): LeadOrigin {
  const data = input.source_data ?? {};
  const source = text(data.source);
  const url = text(input.source_url);
  const tool = text(data.tool);
  const what = tool ? TOOL_WORDS[tool] ?? null : null;

  // 1. Вход, записанный при создании заявки.
  const entry = asLeadEntry(data.entry);
  if (entry) {
    const e = ENTRY_WORDS[entry];
    return origin(e.actor, e.via, what);
  }

  // 2. Заявка через инструменты Ведара до 08.11: вход не записывался.
  if (source === 'mcp' || url.startsWith('mcp://')) {
    const consent = text(input.pd_consent_source);
    const chat = asLeadEntry(consent);
    if (chat && chat.startsWith('kuzmich-')) return origin('human', ENTRY_WORDS[chat].via, what);
    const agentConsent = consent === AGENT_CONSENT || consent === HUMAN_CONFIRMED_CONSENT;
    if (agentConsent && createdSince(input.created_at, CHAT_CONSENT_RECORDED_SINCE)) {
      return origin('agent', 'MCP или A2A (вход до 08.11 не записывался)', what);
    }
    return origin(null, 'MCP, A2A или чат Кузьмича (вход не записан)', what);
  }

  // Человек пришёл на форму по ссылке из ответа ИИ-агента (MCP-handoff, 15.08).
  const referred = text(data.mcp_handoff_id) ? ', по ссылке от ИИ-агента' : '';

  // 3. Формы сайта и боты.
  if (SOURCE_WORDS[source]) return origin('human', SOURCE_WORDS[source] + referred, null);
  // Чат виджета до 15.10 записывал заявки без телефона — не форма, но человек.
  if (data.type === 'widget') return origin('human', 'чат виджета на сайте партнёра', null);

  // 4. Форма без источника — страница, с которой отправлена.
  const page = leadPageUrl(url);
  if (page) return origin('human', pageWords(page) + referred, null);

  // 5. Не записано или не распознано — так и сказано.
  if (source) return origin(null, `не распознано («${source.slice(0, 40)}»)`, null);
  return { actor: null, via: ORIGIN_NOT_RECORDED, what: null, label: ORIGIN_NOT_RECORDED };
}

/**
 * Строка лида для экрана: подпись «откуда» вместо сырого канала согласия.
 * Канал согласия наружу не уходит — экрану нужна только подпись.
 */
export function withLeadOrigin<T extends LeadOriginInput>(row: T): Omit<T, 'pd_consent_source'> & { origin: LeadOrigin } {
  const { pd_consent_source, ...rest } = row;
  return {
    ...rest,
    origin: leadOrigin({ source_url: row.source_url, source_data: row.source_data, pd_consent_source, created_at: row.created_at }),
  };
}
