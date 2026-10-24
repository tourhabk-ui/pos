/**
 * POST /api/max/kuzmich
 * Бот Кузьмич для MAX мессенджера (VK).
 *
 * Два режима:
 *   POST — обработка webhook-апдейтов от MAX
 *   GET  — long-polling: забирает апдейты и обрабатывает (для cron / dev)
 *
 * Заверенный апдейт и прочие (план мини-приложения, §6.5, этап 0; слово
 * владельца 22.10 «а да»). Адрес публичный, тело апдейта пришлёт кто угодно.
 * Ключ подписки задан — запрос без него не обрабатывается вовсе (в лог —
 * хост и путь, не ответ человеку): MAX зовёт адрес с ключом, без ключа
 * приходят подделка или старая подписка. Ключа нет — вопросы Кузьмичу и
 * кнопки тем из любого источника, по одному апдейту на запрос и без записи
 * истории; всё, что меняет что-то за пределами ответа в чат, — вход,
 * подключение чата по ссылке, ответ на запрос мест, кнопки лида, заявка из
 * присланного номера, помощник кабинета, бронь в чате, /reset, — только по
 * заверенному апдейту; на прочие бот говорит, что через MAX это сейчас
 * недоступно (lib/max/verified-press). Кнопки «Оформить заявку» без ключа
 * не показываются: оба пути после неё (номер и бронь в чате) закрыты. Чат
 * кнопки-действия — только из сообщения с кнопкой, без отката на user_id
 * тела: так у заверенного апдейта право нажатия решает чат, названный MAX.
 * Без ключа бот — открытый ответчик: отвечает в чат, названный телом, и
 * подделать его так же легко, как user_id (шапка lib/max/verified-press).
 *
 * «Открой даты словами» (решение владельца 22.10, вариант а): фраза про даты
 * в чате кабинета туроператора — предложение с кнопками «Открыть» / «Не
 * надо» (`od:`), запись — только по нажатию. И фраза, и нажатие — только по
 * заверенному апдейту и только из личного диалога (`chat_type`), чат нажатия
 * — из сообщения с кнопкой; фраза про даты из группы получает ответ «даты —
 * в личном диалоге», а не молчание; порядок проверок и тексты —
 * lib/operators/chat-dates/flow.
 *
 * Env vars: MAX_BOT_TOKEN
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Api } from '@maxhub/max-bot-api';
import { maxBot } from '@/lib/max/max-fetch';
import { type PendingBooking, cleanupPending, processMessage } from '@/lib/kuzmich/core';
import { boundChatLane } from '@/lib/kuzmich/bound-chat-route';
import { PARTNER_EMAIL_BIND_CLOSED, findPartnerByChat } from '@/lib/kuzmich/operator-chat';
import { isRentalPilotSlug, rentalPilotGreeting } from '@/lib/rental/operator-pilot';
import { pool } from '@/lib/db-pool';
import { createLead } from '@/lib/leads/create';
import { claimMaxLoginSession, confirmMaxLoginSession, rejectMaxLoginSession } from '@/lib/auth/max-login';
import { isVerifiedMaxWebhook } from '@/lib/max/webhook-url';
import { applyLeadStatus, parseLeadStatusPayload } from '@/lib/leads/status-action';
import { handlePartnerStart } from '@/lib/partners/bind-channel';
import { handleMemberStart } from '@/lib/operators/member-channel';
import { findMaxAdmin, handleAdminStart } from '@/lib/max/admin-link';
import { parseAnswerPayload, operatorReplyText, statusTokenFromStart, touristBindReplyText } from '@/lib/seat-requests/core';
import { answerSeatRequest, requestBelongsToMaxChat, bindTouristChat } from '@/lib/seat-requests/service';
import {
  type MaxPressAction, LOGIN_CONFIRM_PREFIX, LOGIN_REJECT_PREFIX, MAX_LOGIN_TEXT,
  PRESS_WITHOUT_MESSAGE_REPLY, UNVERIFIED_CHAT_REPLY, UNVERIFIED_PRESS_REPLY,
  UNVERIFIED_START_REPLY, maxWebhookKeyConfigured, pressActionOf, startActionOf,
} from '@/lib/max/verified-press';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { FLOW_TEXT as DATES_TEXT } from '@/lib/operators/chat-dates/texts';
import type { DatesSend } from '@/lib/operators/chat-dates/flow';
import { scrubErrorText } from '@/lib/client-errors/scrub';

type ButtonIntent = 'default' | 'positive' | 'negative';
type MaxButton =
  | { type: 'callback'; text: string; payload: string; intent?: ButtonIntent }
  | { type: 'link'; text: string; url: string }
  | { type: 'request_contact'; text: string }
  | { type: 'message'; text: string };

export const dynamic = 'force-dynamic';

// ── In-memory state ───────────────────────────────────────────────────────────

const pending = new Map<number, PendingBooking>();
setInterval(() => cleanupPending(pending), 5 * 60 * 1000);

let pollingMarker: number | null = null;

// ── MAX API client (lazy init via Bot — we don't start polling) ──────────────

let _api: Api | null = null;
function getApi(): Api | null {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) return null;
  if (!_api) {
    _api = maxBot(token).api;
  }
  return _api;
}

// ── Отказы называются в логе ────────────────────────────────────────────────

/**
 * Пойманный отказ пишется в лог (§4.0): что не выполнено, код (SQLSTATE или
 * код сети) и текст ошибки. Без ПД: ни телефона, ни имени, ни текста
 * сообщения — текст ошибки чистится той же функцией, что ошибки сервера
 * (телефоны, почты, ключи и query адресов вырезаются).
 */
function logFailure(source: string, err: unknown): void {
  const safe = new Error(scrubErrorText(err instanceof Error ? err.message : String(err), 200));
  if (typeof err === 'object' && err !== null && 'code' in err) {
    Object.assign(safe, { code: (err as { code: unknown }).code });
  }
  logSwallowedFailure('max/kuzmich', source, safe);
}

/** Вид апдейта для лога: поле тела, поэтому только узнаваемая форма. */
function updateKind(update: unknown): string {
  const t = typeof update === 'object' && update !== null ? (update as { update_type?: unknown }).update_type : null;
  return typeof t === 'string' && /^[a-z_]{1,40}$/.test(t) ? t : 'неизвестного вида';
}

/**
 * Вид чата для лога: поле тела, поэтому только узнаваемая форма. Подделанный
 * апдейт в режиме без ключа иначе писал бы в лог свои строки — с переводом
 * строки, поддельной записью и телефоном (ревью 22.10).
 */
function chatTypeForLog(v: unknown): string {
  return typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) ? v : 'вид чата не узнан';
}

/**
 * Откуда пришёл запрос, для лога: хост и путь адреса и X-Forwarded-Host (прокси
 * Timeweb подменяет Host своим, исходное имя кладёт туда — next.config.js,
 * «Канон домена»). Без query: в нём ключ подписки. Заголовок присылает кто
 * угодно, поэтому — только узнаваемая форма имени хоста.
 */
function requestOrigin(request: NextRequest): string {
  const hostLike = (v: string | null): string => (v && /^[a-z0-9.:-]{1,100}$/i.test(v) ? v : '—');
  const forwarded = hostLike(request.headers.get('x-forwarded-host'));
  return `хост ${hostLike(request.nextUrl.host)}, путь ${request.nextUrl.pathname.slice(0, 100)}, x-forwarded-host ${forwarded}`;
}

// ── Reply via MAX API ─────────────────────────────────────────────────────────

async function maxReply(chatId: number, text: string): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    await api.sendMessageToChat(chatId, text, { format: 'html' });
  } catch (err) {
    // Ответ не блокирует обработку, но отказ доставки виден в логе.
    logFailure('ответ в чат MAX', err);
  }
}

/** Ответ в личный чат человека по его user_id — только из заверенного апдейта. */
async function maxReplyToUser(userId: number, text: string): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    await api.sendMessageToUser(userId, text, { format: 'html' });
  } catch (err) {
    logFailure('ответ в личный чат MAX', err);
  }
}

async function maxReplyWithButtons(chatId: number, text: string, buttons: MaxButton[][]): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    await (api.sendMessageToChat as (chatId: number, text: string, opts: unknown) => Promise<unknown>)(chatId, text, {
      format: 'html',
      attachments: [{ type: 'inline_keyboard', payload: { buttons } }],
    });
  } catch (err) {
    logFailure('ответ с кнопками в чат MAX', err);
  }
}

/** Ответ «Беру» / «Не могу»: правим то же сообщение и снимаем кнопки. */
function rentalAnswerSend(chatId: number) {
  return async (text: string, editMid: string | null): Promise<void> => {
    const api = getApi();
    if (editMid && api) {
      try {
        const res = await (api.editMessage as (id: string, extra: unknown) => Promise<{ success?: boolean }>)(editMid, {
          text,
          format: 'html',
          attachments: [],
        });
        if (res?.success !== false) return;
        console.error('[max/kuzmich] правка ответа на заявку проката не принята MAX — отправляю новым сообщением');
      } catch (err) {
        logFailure('правка ответа на заявку проката', err);
      }
    }
    await maxReply(chatId, text);
  };
}

/** Календарь проката: правим то же сообщение, иначе шлём новое. Кнопки — `rb:`. */
function rentalCalendarSend(chatId: number) {
  return async (
    text: string,
    buttons: Array<Array<{ text: string; payload: string; intent?: 'positive' | 'negative' }>>,
    editMid: string | null,
  ): Promise<void> => {
    const rows = buttons.map((row) => row.map((b) => (
      b.intent
        ? { type: 'callback' as const, text: b.text, payload: b.payload, intent: b.intent }
        : { type: 'callback' as const, text: b.text, payload: b.payload }
    )));
    const api = getApi();
    if (editMid && api) {
      try {
        const res = await (api.editMessage as (id: string, extra: unknown) => Promise<{ success?: boolean }>)(editMid, {
          text,
          format: 'html',
          attachments: [{ type: 'inline_keyboard', payload: { buttons: rows } }],
        });
        if (res?.success !== false) return;
        console.error('[max/kuzmich] правка календаря проката не принята MAX — отправляю новым сообщением');
      } catch (err) {
        logFailure('правка календаря проката', err);
      }
    }
    if (rows.length === 0) await maxReply(chatId, text);
    else await maxReplyWithButtons(chatId, text, rows);
  };
}

/** Ответ потока дат в чат кабинета: кнопки — callback с payload `od:`. */
function datesSend(chatId: number): DatesSend {
  return async (text, buttons) => {
    if (!buttons?.length) {
      await maxReply(chatId, text);
      return;
    }
    await maxReplyWithButtons(chatId, text, buttons.map((row) => row.map((b) => (
      b.intent ? { type: 'callback' as const, text: b.text, payload: b.payload, intent: b.intent }
        : { type: 'callback' as const, text: b.text, payload: b.payload }
    ))));
  };
}

// ── Кнопки по лиду ────────────────────────────────────────────────────────────

function escHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Уведомления о лидах содержат ПД туриста и потому живут в MAX (решение
 * владельца 23.08). Кнопки под ними обязаны работать здесь же — иначе это
 * обещание действия, которого не произойдёт.
 *
 * Ответ называет исход по имени: сменили, не нашли, не смогли. Имя туриста в
 * подтверждении повторяется — оно и так уже в этом чате, в самом уведомлении.
 */
async function handleLeadCallback(payload: string, chatId: number): Promise<void> {
  const [action, ...rest] = payload.split(':');
  const leadId = rest.join(':');

  if (action === 'lead_ai') {
    try {
      const { leadProcessor } = await import('@/lib/services/operators/lead-processor.service');
      const { notifyOperatorProposal } = await import('@/lib/notifications/lead-notify');
      const proposal = await leadProcessor.process(leadId);
      await notifyOperatorProposal(proposal);
      await maxReply(chatId, 'AI-обработка запущена, предложение придёт отдельным сообщением.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'неизвестная ошибка';
      await maxReply(chatId, `AI-обработка не выполнена: ${msg.slice(0, 300)}`);
    }
    return;
  }

  if (action === 'lead_send') {
    try {
      const { sendProposalToClient } = await import('@/lib/leads/proposal-delivery');
      const outcome = await sendProposalToClient(leadId);
      await maxReply(chatId, outcome.ok
        ? `Предложение ушло клиенту. ${outcome.message}`
        : `Предложение не ушло: ${outcome.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'неизвестная ошибка';
      await maxReply(chatId, `Предложение не ушло: ${msg.slice(0, 300)}`);
    }
    return;
  }

  const parsed = parseLeadStatusPayload(payload);
  if (!parsed) {
    await maxReply(chatId, `Действие ${action} не распознано.`);
    return;
  }

  const res = await applyLeadStatus(parsed.prefix, parsed.leadId);
  if (res.outcome === 'updated') {
    await maxReply(chatId, `Лид <b>${escHtml(res.name)}</b> — статус: <b>${res.label}</b>\n<code>${escHtml(parsed.leadId)}</code>`);
  } else if (res.outcome === 'not_found') {
    await maxReply(chatId, 'Лид не найден — статус не изменён.');
  } else {
    await maxReply(chatId, `Статус не изменён: ${res.reason}`);
  }
}

// ── Стартовое меню ────────────────────────────────────────────────────────────

const START_MENU: MaxButton[][] = [
  [
    { type: 'callback', text: 'Рыбалка', payload: 'topic_fishing' },
    { type: 'callback', text: 'Вулканы', payload: 'topic_volcanoes' },
  ],
  [
    { type: 'callback', text: 'Медведи', payload: 'topic_bears' },
    { type: 'callback', text: 'Источники', payload: 'topic_springs' },
  ],
  [
    { type: 'callback', text: 'Подобрать тур', payload: 'topic_tour', intent: 'positive' },
    { type: 'callback', text: 'Цены', payload: 'topic_prices' },
  ],
];

const TOPIC_TEXTS: Record<string, string> = {
  topic_fishing: 'Рыбалка на Камчатке',
  topic_volcanoes: 'Вулканы Камчатки',
  topic_bears: 'Медведи Камчатки',
  topic_springs: 'Термальные источники',
  topic_tour: 'Подобрать тур на Камчатку',
  topic_prices: 'Цены на туры на Камчатку',
};

// Обнаружение рекомендации тура в ответе бота
function hasTourRecommendation(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('тур') || lower.includes('маршрут') || lower.includes('программа') || lower.includes('экскурс');
}

/**
 * Предлагать ли «Оформить заявку» после ответа. Только заверенному апдейту:
 * без него оба пути после кнопки — присланный номер и бронь в чате — не
 * применяются (lib/max/verified-press), и кнопка обещала бы то, чего не будет.
 */
function offersBooking(verified: boolean, reply: string): boolean {
  return verified && reply !== '' && hasTourRecommendation(reply);
}

/** Текст туриста — Кузьмич туриста, в том числе из привязанного чата. */
async function deliverTouristText(opts: {
  chatId: number;
  text: string;
  userName: string | null;
  userId: number | null;
  /** Тот же флаг, что у вебхука: `opts?.verifiedOrigin` вызывающего. */
  verifiedOrigin: boolean | undefined;
  reply: (chatId: number, text: string) => Promise<void>;
  replyButtons: (chatId: number, text: string, buttons: MaxButton[][]) => Promise<void>;
}): Promise<void> {
  let capturedReply = '';
  const verified = opts?.verifiedOrigin === true;
  await processMessage({
    chatId: opts.chatId,
    text: opts.text,
    userName: opts.userName,
    userId: opts.userId,
    mode: 'max',
    createdVia: 'max',
    pending,
    reply: async (id, msg) => {
      capturedReply = msg;
      await opts.reply(id, msg);
    },
    platform: 'max',
    verifiedOrigin: opts?.verifiedOrigin === true,
  });
  if (offersBooking(verified, capturedReply)) {
    await opts.replyButtons(opts.chatId, 'Хотите оформить заявку?', BOOKING_BUTTONS);
  }
}

const BOOKING_BUTTONS: MaxButton[][] = [
  [
    { type: 'callback', text: 'Оформить заявку', payload: 'book_now', intent: 'positive' },
    { type: 'callback', text: 'Другой вариант', payload: 'other_tour' },
  ],
  [
    { type: 'link', text: 'Все туры на сайте', url: 'https://vedarai.ru/routes' },
  ],
];

// ── Кнопка «Перезвоните мне» ─────────────────────────────────────────────────

const CONTACT_REQUEST_BUTTONS: MaxButton[][] = [
  [{ type: 'request_contact', text: 'Поделиться номером' }],
  [{ type: 'callback', text: 'Напишу сам', payload: 'skip_contact' }],
];

// Парсинг телефона из VCF-строки (формат: TEL:+7... или TEL;TYPE=...:+7...)
function parsePhoneFromVcf(vcf: string): string | null {
  const match = vcf.match(/^TEL[^:]*:(.+)$/m);
  if (!match) return null;
  return match[1].trim().replace(/\s+/g, '');
}

// Создать лид из MAX-контакта. Исход честный: «номер получен» человек
// слышит только тогда, когда заявка записана (createLead вернул id).
async function createLeadFromContact(
  chatId: number,
  phone: string,
  name: string,
  comment: string,
): Promise<boolean> {
  try {
    const id = await createLead({
      name: name || 'Турист',
      phone,
      comment,
      source_url: 'https://max.ru',
      source_data: { source: 'max_bot', max_chat_id: chatId, timestamp: new Date().toISOString() },
      status: 'new',
    });
    if (!id) console.error('[max/kuzmich] заявка из присланного номера не записана: createLead вернул пусто');
    return id !== null;
  } catch (err) {
    logFailure('заявка из присланного номера', err);
    return false;
  }
}

// ── Скачивание медиа по URL → base64 ─────────────────────────────────────────

// SSRF-барьер (CodeQL js/request-forgery, HIGH): URL медиа приходит из тела
// вебхука (attacker-controlled), а fetch по нему мог бы бить во внутренние
// адреса (169.254.169.254, localhost, внутренние сервисы). Пускаем ТОЛЬКО https
// на разрешённые хосты MAX. Если реальные медиа-URL MAX на другом CDN — добавить
// хост в env MAX_MEDIA_HOSTS (список через запятую); дефолт — max.ru и поддомены.
function isAllowedMediaUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const allow = (process.env.MAX_MEDIA_HOSTS ?? 'max.ru')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return allow.some(a => host === a || host.endsWith('.' + a));
}

async function downloadMedia(url: string): Promise<{ base64: string; mimeType: string } | null> {
  if (!isAllowedMediaUrl(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error(`[max/kuzmich] медиа не скачано: HTTP ${res.status}`);
      return null;
    }
    const ct = res.headers.get('content-type') ?? 'application/octet-stream';
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString('base64'), mimeType: ct.split(';')[0].trim() };
  } catch (err) {
    logFailure('скачивание медиа', err);
    return null;
  }
}

// ── Типы апдейтов MAX ────────────────────────────────────────────────────────

interface MaxAttachment {
  type: string;
  payload?: {
    url?: string;
    token?: string;
    photo_id?: number;
    // contact
    vcf_info?: string | null;
    tam_info?: { user_id?: number; name?: string } | null;
  };
  filename?: string;
}

interface MaxUpdate {
  update_type: string;
  timestamp: number;
  // message_created
  message?: {
    sender?: { user_id: number; name: string; username?: string | null } | null;
    recipient: { chat_id: number | null; chat_type: string };
    body: { mid: string; seq: number; text: string | null; attachments?: MaxAttachment[] | null };
  };
  // bot_started
  chat_id?: number;
  user?: { user_id: number; name: string; username?: string | null };
  payload?: string | null;
  // message_callback
  callback?: {
    timestamp: number;
    callback_id: string;
    payload?: string;
    user: { user_id: number; name: string };
  };
  // сообщение с кнопками (приходит в message_callback)
  // message уже есть выше для message_created, переиспользуем структуру
}

// ── Кнопки-действия ───────────────────────────────────────────────────────────

/**
 * Нажатие кнопки, которая что-то меняет: ответ оператора на запрос мест
 * (`sr:`) и кнопки лида (`lead_`). Три ворот, по порядку:
 *  1. чат — только из сообщения с кнопкой; нет его — право нажатия не
 *     проверить, нажатие не применяется. Заверенному нажатию об этом
 *     говорится в личном чате нажавшего (его user_id прислал MAX). Незаверенному
 *     без сообщения не отвечаем: его user_id — такое же поле тела, как чат, и
 *     это не защита, а отказ давать телу второе поле для выбора адресата;
 *  2. апдейт заверен (серверный флаг, не поле тела); нет — отвечаем, что
 *     нажатие не засчитано, и ничего не меняем. Ответ уходит в чат из тела:
 *     без ключа это открытый ответчик (шапка lib/max/verified-press);
 *  3. чат вправе нажимать: для мест — MAX-чат оператора запроса, для лида —
 *     рабочий MAX_OPERATOR_CHAT_ID, для дат — личный диалог (`chatType`) чата
 *     кабинета туроператора, чьё это предложение (lib/operators/chat-dates).
 */
async function handleActionPress(
  action: MaxPressAction,
  payload: string,
  chatId: number | null,
  verified: boolean,
  presserId: number | null,
  chatType: string | null,
  pressed?: { mid: string; text: string | null } | null,
): Promise<void> {
  if (!chatId) {
    console.error(`[max/kuzmich] нажатие (${action}) без чата сообщения — не применено`);
    if (verified && presserId) await maxReplyToUser(presserId, PRESS_WITHOUT_MESSAGE_REPLY[action]);
    return;
  }
  if (!verified) {
    console.error(`[max/kuzmich] нажатие (${action}) из незаверенного апдейта — не применено`);
    await maxReply(chatId, UNVERIFIED_PRESS_REPLY[action]);
    return;
  }

  // Вход на сайт: «Да, это я» / «Нет, не я» после «Старта» по ссылке входа.
  // Право нажатия — пользователь MAX, за которым сессия закреплена «Стартом»
  // (условие в SQL, lib/auth/max-login); его user_id в заверенном апдейте
  // прислал MAX. Чат сообщения — личный чат с ботом, туда и ответ.
  if (action === 'login') {
    const confirm = payload.startsWith(LOGIN_CONFIRM_PREFIX);
    const nonce = payload.slice((confirm ? LOGIN_CONFIRM_PREFIX : LOGIN_REJECT_PREFIX).length);
    const done = presserId === null ? false
      : confirm ? await confirmMaxLoginSession(nonce, presserId)
      : await rejectMaxLoginSession(nonce, presserId);
    await maxReply(chatId, !done ? MAX_LOGIN_TEXT.stale : confirm ? MAX_LOGIN_TEXT.confirmed : MAX_LOGIN_TEXT.rejected);
    return;
  }

  // «Открыть» / «Не надо» / выбор тура под предложением открыть даты. Только
  // личный диалог: в группе кнопку нажал бы любой участник. Отказ — в лог,
  // без ответа: чат не тот, и отвечать в него нечего.
  if (action === 'dates') {
    if (chatType !== 'dialog') {
      console.error(`[max/kuzmich] нажатие (dates) не из личного диалога (${chatTypeForLog(chatType)}) — не применено`);
      return;
    }
    const lookup = await findPartnerByChat('max', chatId);
    const { handleOperatorDatesPress } = await import('@/lib/operators/chat-dates/flow');
    await handleOperatorDatesPress({ payload, chatId, lookup, send: datesSend(chatId) });
    return;
  }

  // Календарь проката (`rb:`) и ответ на заявку (`rr:`). Только личный диалог
  // и только чат привязанного пилота. Чужой payload машину не отмечает.
  if (action === 'rental') {
    if (chatType !== 'dialog') {
      console.error(`[max/kuzmich] нажатие (rental) не из личного диалога (${chatTypeForLog(chatType)}) — не применено`);
      const line = payload.startsWith('rr:')
        ? 'Ответ на заявку принимается в личном диалоге с ботом. Здесь ничего не записал.'
        : 'Календарь проката отмечается в личном диалоге с ботом. Отметка не записана.';
      await maxReply(chatId, line);
      return;
    }
    const lookup = await findPartnerByChat('max', chatId);
    if (payload.startsWith('rr:')) {
      const { handleRentalRequestAnswer } = await import('@/lib/rental/request-answer-flow');
      await handleRentalRequestAnswer({
        lookup,
        payload,
        editMid: pressed?.mid ?? null,
        originalText: pressed?.text ?? null,
        send: rentalAnswerSend(chatId),
      });
      return;
    }
    const { handleRentalCalendarPress } = await import('@/lib/rental/car-calendar-flow');
    await handleRentalCalendarPress({
      lookup, payload, nowMs: Date.now(), editMid: pressed?.mid ?? null, send: rentalCalendarSend(chatId),
    });
    return;
  }

  if (action === 'seat') {
    const seat = parseAnswerPayload(payload);
    if (!seat) {
      await maxReply(chatId, 'Кнопка не распознана, ответ не принят. Ответьте по ссылке «ответить на сайте» в том же сообщении.');
      return;
    }
    const mine = await requestBelongsToMaxChat(seat.requestId, chatId);
    if (mine !== true) {
      await maxReply(chatId, operatorReplyText({ ok: false, reason: mine === 'db_error' ? 'db_error' : 'not_yours' }));
      return;
    }
    const result = await answerSeatRequest(seat.requestId, { kind: seat.kind }, 'max');
    const reply = operatorReplyText(result);
    // Пилот «Камчатская рыбалка»: правим само сообщение запроса — «✓ Ответ
    // дан», кнопки ответа убраны. Не вышло — ответ отдельным сообщением.
    if (pressed?.mid && (result.ok || result.reason === 'already_answered')
        && await editAnsweredRequest(chatId, pressed.mid, pressed.text, reply)) {
      return;
    }
    await maxReply(chatId, reply);
    return;
  }

  // Кнопки по лиду. Право нажатия — рабочий чат MAX_OPERATOR_CHAT_ID: чат
  // сообщения с кнопкой из заверенного апдейта подделать нельзя. Тот же
  // принцип, что в Telegram-вебхуке.
  const operatorChat = process.env.MAX_OPERATOR_CHAT_ID?.trim() ?? '';
  if (!operatorChat || String(chatId) !== operatorChat) {
    await maxReply(chatId, 'Действие по лиду доступно только в рабочем чате.');
    return;
  }
  await handleLeadCallback(payload, chatId);
}

/**
 * Правка сообщения запроса мест после ответа (пилот, флаг summaryEnabledFor).
 * true — правка принята MAX; false — не пилот или правка не удалась.
 */
async function editAnsweredRequest(chatId: number, mid: string, originalText: string | null, reply: string): Promise<boolean> {
  const api = getApi();
  if (!api) return false;
  const lookup = await findPartnerByChat('max', chatId);
  const { summaryEnabledFor } = await import('@/lib/seat-requests/summary');
  if (lookup.outcome !== 'found' || !summaryEnabledFor(lookup.partner.partnerId)) return false;
  const edit = await import('@/lib/seat-requests/answer-edit');
  try {
    const res = await (api.editMessage as (id: string, extra: unknown) => Promise<{ success?: boolean }>)(mid, {
      text: edit.answeredEditText(originalText, reply),
      format: 'html',
      attachments: [{ type: 'inline_keyboard', payload: { buttons: edit.afterAnswerButtons() } }],
    });
    if (res?.success === false) {
      console.error('[max/kuzmich] правка сообщения запроса не принята MAX — ответ отдельным сообщением');
      return false;
    }
    return true;
  } catch (err) {
    logFailure('правка сообщения запроса мест', err);
    return false;
  }
}

// ── Обработка одного апдейта ──────────────────────────────────────────────────

async function handleUpdate(update: MaxUpdate, opts?: { verifiedOrigin?: boolean }): Promise<void> {
  // ── ВХОД ЧЕРЕЗ MAX ─────────────────────────────────────────────────────────
  // Решение о подтверждении входа принимается ТОЛЬКО по verifiedOrigin —
  // это серверный флаг (секрет в URL вебхука / long-polling), НЕ поле из тела
  // апдейта. Он доминирует над всей веткой: незаверенный источник вообще не
  // доходит до аутентификации (защита от захвата аккаунта, security-ревью #961).
  // Данные о пользователе берём из апдейта только ПОСЛЕ прохождения этого гейта.
  if (opts?.verifiedOrigin === true
      && update.update_type === 'bot_started'
      && update.chat_id
      && typeof update.payload === 'string'
      && update.payload.startsWith('login-')) {
    const nonce = update.payload.slice('login-'.length);
    // «Старт» вход НЕ подтверждает (аудит 22.10): ссылку входа создаёт любой,
    // и присланная чужим человеком ссылка входила бы им в аккаунт нажавшего.
    // Сессия закрепляется за этим пользователем MAX, а вход выдаёт только его
    // же «Да, это я» — кнопка-действие login (handleActionPress).
    const claimed = await claimMaxLoginSession(nonce, {
      maxUserId: update.user?.user_id ?? update.chat_id,
      name: update.user?.name ?? null,
      username: update.user?.username ?? null,
    });
    if (!claimed) {
      await maxReply(update.chat_id, MAX_LOGIN_TEXT.stale);
      return;
    }
    await maxReplyWithButtons(update.chat_id, MAX_LOGIN_TEXT.ask, [
      [{ type: 'callback', text: 'Да, это я', payload: `${LOGIN_CONFIRM_PREFIX}${nonce}`, intent: 'positive' }],
      [{ type: 'callback', text: 'Нет, не я', payload: `${LOGIN_REJECT_PREFIX}${nonce}`, intent: 'negative' }],
    ]);
    return;
  }

  // bot_started → обычный /start; ссылка старта — только по заверенному апдейту
  if (update.update_type === 'bot_started' && update.chat_id) {
    // ── ПОДКЛЮЧЕНИЕ ОПЕРАТОРА И ТУРИСТА ────────────────────────────────────
    // Чат, куда пойдут имена и телефоны туристов и ссылка на бронь,
    // назначается только по заверенному источнику апдейта (verifiedOrigin —
    // серверный флаг, НЕ поле тела). Ворота настоящие — подпись ссылки
    // (lib/partners/channel-link, HMAC) и ключ запроса (хэш в базе); форму
    // payload проверяют сами разборщики. Ссылку оператору выдаёт администратор.
    if (opts?.verifiedOrigin === true) {
      const startArg = typeof update.payload === 'string' ? update.payload : '';
      const seatToken = statusTokenFromStart(startArg);
      if (seatToken !== null) {
        // Турист хочет получить ответ оператора на запрос мест сюда.
        const bound = await bindTouristChat(seatToken, 'max', update.chat_id);
        await maxReply(update.chat_id, touristBindReplyText(bound));
        return;
      }

      const chatId = update.chat_id;
      // Администратор подключает свой MAX одноразовой ссылкой из админки
      // (lib/max/admin-link, слово владельца 23.10). Привязывается человек —
      // user_id апдейта, без отката на id чата.
      const starterId = typeof update.user?.user_id === 'number' ? update.user.user_id : null;
      if (await handleAdminStart(startArg, starterId, (text) => maxReply(chatId, text))) return;
      if (await handlePartnerStart(startArg, 'max', chatId, (text) => maxReply(chatId, text))) return;
      // Менеджер команды оператора — свой чат к уведомлениям кабинета (2г-4).
      if (await handleMemberStart(startArg, 'max', chatId, (text) => maxReply(chatId, text))) return;
    } else {
      // Незаверенная ссылка входа или подключения: ничего не подключаем и не
      // молчим приветствием — человек нажал ссылку ради действия и должен
      // узнать, что оно не прошло (§4.0). Обычный /start — ниже, как раньше.
      const startAction = startActionOf(update.payload);
      if (startAction !== null) {
        console.error(`[max/kuzmich] ссылка старта (${startAction}) из незаверенного апдейта — не применена`);
        await maxReply(update.chat_id, UNVERIFIED_START_REPLY[startAction]);
        return;
      }
    }

    // Администратор на «Старт» — своё приветствие и список того, что можно
    // спросить, а не туристское меню. Только по заверенному апдейту: человек
    // из тела незаверенного запроса — то, что прислал кто угодно.
    if (opts?.verifiedOrigin === true && typeof update.user?.user_id === 'number') {
      const admin = await findMaxAdmin(update.user.user_id);
      if (admin.outcome === 'admin') {
        const { adminGreeting } = await import('@/lib/max/admin-chat');
        await maxReply(update.chat_id, adminGreeting(admin.name));
        return;
      }
    }

    // Прокатчик пилота уже привязан: обычный «Старт» без ссылки привязку не
    // пишет и не открывает туристское меню. Ссылку op_ разобрал
    // handlePartnerStart выше. Ссылка администратора adm_ (#2746) — другая
    // дверь: она привязывает человека с ролью администратора, не карточку
    // прокатчика, и до этого места не доходит.
    if (opts?.verifiedOrigin === true) {
      const boundPilot = await findPartnerByChat('max', update.chat_id);
      if (boundPilot.outcome === 'found' && isRentalPilotSlug(boundPilot.partner.slug)) {
        await maxReply(update.chat_id, rentalPilotGreeting(boundPilot.partner.partnerName));
        return;
      }
    }

    let capturedStart = '';
    const capturingStart = async (id: number, text: string) => {
      capturedStart = text;
      await maxReply(id, text);
    };
    await processMessage({
      chatId: update.chat_id,
      text: '/start',
      userName: update.user?.name ?? null,
      userId: update.user?.user_id ?? null,
      mode: 'max',
      createdVia: 'max',
      pending,
      reply: capturingStart,
      platform: 'max',
      verifiedOrigin: opts?.verifiedOrigin === true,
    });
    if (capturedStart) {
      await maxReplyWithButtons(update.chat_id, 'Выберите тему или задайте вопрос:', START_MENU);
    }
    return;
  }

  // message_created → текст / фото / голос
  if (update.update_type === 'message_created' && update.message) {
    const msg = update.message;
    const chatId = msg.recipient.chat_id;
    if (!chatId) return;
    // Ignore group chats and channels (negative chat_ids) — only process DMs
    if (chatId < 0) return;

    const text = msg.body.text?.trim() ?? '';
    const attachments = msg.body.attachments ?? [];
    const userName = msg.sender?.name ?? null;
    const userId = msg.sender?.user_id ?? null;

    // ── АДМИНИСТРАТОР (слово владельца 23.10) ─────────────────────────────
    // Раньше всех веток: вложения ниже создали бы лид из номера
    // администратора и отправили бы голос в зарубежную модель, а помощник
    // партнёра забрал бы чат, если он ещё и привязан к карточке. Права —
    // заново на каждом сообщении (lib/max/admin-link): заверенный апдейт,
    // личный диалог, человек MAX привязан и его аккаунт сейчас владеет ролью
    // администратора. Группы и незаверенные апдейты базу здесь не трогают.
    if (opts?.verifiedOrigin === true && msg.recipient.chat_type === 'dialog' && typeof userId === 'number') {
      const admin = await findMaxAdmin(userId);
      if (admin.outcome === 'admin') {
        const { ADMIN_CHAT_TEXT, handleAdminMessage } = await import('@/lib/max/admin-chat');
        if (!text) {
          await maxReply(chatId, ADMIN_CHAT_TEXT.textOnly);
          return;
        }
        // Просьба туриста — Кузьмичу туриста раньше разбора команды.
        // Иначе «хочу забронировать тур» читается как «брони»: в команде
        // администратора подстрока «брон» где угодно. Кабинет («покажи брони»,
        // «даты», «сводка») классификатор оставляет кабинетом.
        if (!/^\/start\b/i.test(text.trim()) && boundChatLane(text) === 'tourist') {
          await deliverTouristText({
            chatId, text, userName, userId, verifiedOrigin: opts?.verifiedOrigin, reply: maxReply, replyButtons: maxReplyWithButtons,
          });
          return;
        }
        await handleAdminMessage({ text, name: admin.name, chatId, reply: maxReply });
        return;
      }
      // «Не смог проверить» (база не ответила; причина — в логе самой
      // проверки) идёт дальше обычным путём: кто пишет, неизвестно, и ответ
      // «права администратора не проверены» туристу был бы чужим. Обычный
      // путь ПД туристов не показывает, так что администратору он ничего
      // лишнего не откроет — только не узнает его на одно сообщение.
    }

    // Фото → Gemini Vision
    const photoAtt = attachments.find(a => a.type === 'image');
    if (photoAtt?.payload?.url) {
      await maxReply(chatId, 'Смотрю на фото...');
      let visionDescription: string | undefined;
      try {
        const mediaData = await downloadMedia(photoAtt.payload.url);
        if (mediaData) {
          // Что видно и факты места из базы — одно правило на все каналы.
          const { describeKuzmichPhoto } = await import('@/lib/kuzmich/photo-vision');
          visionDescription = await describeKuzmichPhoto(mediaData.base64, mediaData.mimeType) ?? undefined;
        }
      } catch (err) {
        // Ответ без фото лучше, чем никакой; но отказ виден в логе.
        console.error('[max/kuzmich] фото не разобрано', err instanceof Error ? err.message : err);
      }

      await processMessage({
        chatId, text: text || 'Что это за место?',
        userName, userId, mode: 'max',
        createdVia: 'max', pending, reply: maxReply, visionDescription,
        platform: 'max',
        verifiedOrigin: opts?.verifiedOrigin === true,
      });
      return;
    }

    // Голос / аудио → Gemini Transcribe
    const audioAtt = attachments.find(a => a.type === 'audio');
    if (audioAtt?.payload?.url) {
      await maxReply(chatId, 'Слушаю...');
      // Те же два отказа и те же две фразы, что в Telegram (см. там же).
      let transcription: string | undefined;
      let voiceFailure: 'unintelligible' | 'unavailable' = 'unavailable';
      try {
        const mediaData = await downloadMedia(audioAtt.payload.url);
        if (mediaData) {
          const { callGeminiTranscribe } = await import('@/lib/ai/providers');
          const outcome = await callGeminiTranscribe(mediaData.base64, mediaData.mimeType);
          if (outcome.ok) transcription = outcome.text;
          else voiceFailure = outcome.reason;
        }
      } catch (err) {
        // Человеку — «распознавание недоступно», в лог — причина.
        logFailure('распознавание голосового', err);
      }

      if (!transcription) {
        await maxReply(chatId, voiceFailure === 'unintelligible'
          ? 'Не разобрал голосовое. Напишите текстом?'
          : 'Распознавание речи сейчас недоступно — напишите, пожалуйста, текстом.');
        return;
      }

      await maxReply(chatId, `<i>Вы сказали: ${transcription}</i>`);
      await processMessage({
        chatId, text: transcription, userName, userId,
        mode: 'max', createdVia: 'max_voice', pending, reply: maxReply,
        platform: 'max',
        verifiedOrigin: opts?.verifiedOrigin === true,
      });
      return;
    }

    // Видео → описание через Vision
    const videoAtt = attachments.find(a => a.type === 'video');
    if (videoAtt?.payload?.url) {
      await maxReply(chatId, 'Видео пока не умею анализировать. Опишите словами или пришлите фото.');
      return;
    }

    // Контакт → создаём лид. Заявка с телефоном уходит менеджерам вместе с
    // ПД — только по заверенному апдейту, иначе её создал бы кто угодно с
    // чужими именем и номером.
    const contactAtt = attachments.find(a => a.type === 'contact');
    if (contactAtt) {
      if (opts?.verifiedOrigin !== true) {
        console.error('[max/kuzmich] номер из незаверенного апдейта — заявка не создана');
        await maxReply(chatId, UNVERIFIED_CHAT_REPLY.contact);
        return;
      }
      const vcf = contactAtt.payload?.vcf_info ?? '';
      const phone = parsePhoneFromVcf(vcf)
        ?? contactAtt.payload?.tam_info?.user_id?.toString()
        ?? null;
      const contactName = contactAtt.payload?.tam_info?.name ?? userName ?? 'Турист';

      if (phone) {
        const saved = await createLeadFromContact(chatId, phone, contactName, 'Заявка из MAX бота');
        await maxReply(chatId, saved
          ? `Отлично, ${contactName}! Номер получен.\n\nОператор свяжется с вами в течение <b>1-2 часов</b> по номеру <b>${phone}</b>.`
          : 'Номер не сохранился — сбой на нашей стороне. Попробуйте ещё раз через минуту.',
        );
      } else {
        await maxReply(chatId, 'Не удалось получить номер. Напишите его текстом, пожалуйста.');
      }
      return;
    }

    // «/partner EMAIL», «партнер EMAIL» — привязка по почте закрыта (09.10):
    // отвечаем, как подключиться, а не роняем в туристский поток. Ловим только
    // с почтой — «партнер» в обычной фразе туриста остаётся его вопросом.
    const lc = text.toLowerCase();
    if (/^(\/partner|партн[её]р|оператор)\s+\S+@\S+/.test(lc)) {
      await maxReply(chatId, PARTNER_EMAIL_BIND_CLOSED);
      return;
    }

    // Текст
    if (text) {
      // «Открой даты словами» (22.10): фраза про даты в чате партнёра — в
      // поток дат. Предложение — только в личном диалоге: в группе
      // (положительный id бывает и у них) кнопку нажал бы любой участник, и
      // поток отвечает «даты — в личном диалоге» (четвёртый ревью 22.10:
      // раньше фраза пропадала молча). Туристу вид чата ничего не меняет — его
      // сообщение идёт Кузьмичу, как раньше.
      const datesIntent = chatDatesIntent(text);
      const dialog = msg.recipient.chat_type === 'dialog';
      // Привязанный чат: кабинет — помощнику партнёра (CRM 1д), просьба
      // туриста — Кузьмичу туриста (`boundChatLane`). «Не смогли проверить»
      // записано в лог самой проверкой и ведёт в туристский поток — как в
      // Telegram. Кроме фразы про даты: туристский Кузьмич ответил бы на
      // «открой субботы июля» по-своему, а «не смог проверить» не равно
      // «это турист» (§4.0).
      const lookup = await findPartnerByChat('max', chatId);
      if (lookup.outcome !== 'none' && datesIntent === 'dates' && !dialog) {
        console.error(`[max/kuzmich] фраза про даты не из личного диалога (${chatTypeForLog(msg.recipient.chat_type)}) — без предложения`);
      }
      if (lookup.outcome === 'unavailable' && datesIntent === 'dates') {
        await maxReply(chatId, DATES_TEXT.partnerUnknown);
        return;
      }
      // Просьба туриста в привязанном чате не уходит помощнику CRM: тот
      // отвечает про клиентов и свои туры и отказывает в аренде. Кабинет
      // (CRM, даты, календарь, прайс) — прежняя ветка, только по заверенному
      // апдейту. Незаверенная просьба туриста идёт Кузьмичу как обычный
      // вопрос, без записи в CRM.
      // Поток дат всё равно смотрит заверенную просьбу: «спланируй поездку
      // на 5 дней» — не команда открыть даты, но цифра в ней снимает
      // действующую кнопку «Открыть». Иначе старая кнопка пишет даты.
      if (lookup.outcome === 'found' && boundChatLane(text) === 'tourist' && opts?.verifiedOrigin === true) {
        const { handleOperatorDatesText } = await import('@/lib/operators/chat-dates/flow');
        const handled = await handleOperatorDatesText({
          chatId, sourceMid: msg.body.mid ?? null, text, partner: lookup.partner, send: datesSend(chatId), dialog,
          sentAtMs: Number.isFinite(update.timestamp) ? update.timestamp : null,
        });
        if (handled) return;
      }
      if (lookup.outcome === 'found' && boundChatLane(text) !== 'tourist') {
        // Помощник кабинета пишет в CRM партнёра (касания, задачи) — только по
        // заверенному апдейту: чат партнёра в теле прислал бы кто угодно.
        if (opts?.verifiedOrigin !== true) {
          console.error('[max/kuzmich] сообщение в чат партнёра из незаверенного апдейта — помощник не запущен');
          await maxReply(chatId, UNVERIFIED_CHAT_REPLY.partner);
          return;
        }
        // «/сводка» — числа по запросам мест (пилот «Камчатская рыбалка»,
        // флаг по партнёру). Только числа, тур и дата — без ПД туриста.
        const summary = await import('@/lib/seat-requests/summary');
        if (summary.isSummaryCommand(text) && summary.summaryEnabledFor(lookup.partner.partnerId)) {
          const read = await summary.readSeatSummary(lookup.partner.partnerId);
          await maxReply(chatId, read === 'db_error' ? summary.SUMMARY_DB_ERROR : summary.summaryText(read));
          return;
        }
        // «Следующая заявка» — ожидающий запрос с ближайшим сроком, с кнопками.
        if (summary.summaryEnabledFor(lookup.partner.partnerId)) {
          const next = await import('@/lib/seat-requests/answer-edit');
          if (next.isNextCommand(text)) {
            const r = await next.readNextPending(lookup.partner.partnerId);
            if (r === 'db_error' || r === null) {
              await maxReply(chatId, r === null ? next.NEXT_NONE : next.NEXT_DB_ERROR);
            } else {
              const { operatorAnswerUrl } = await import('@/lib/seat-requests/service');
              const card = next.nextRequestCard(r, operatorAnswerUrl(r.id));
              await maxReplyWithButtons(chatId, card.text, card.buttons);
            }
            return;
          }
        }
        // Поток дат смотрит каждое сообщение партнёра: не про даты — false, но
        // поправка («нет, 4 места»), ушедшая помощнику, снимает действующее
        // предложение туроператора (пятый ревью 22.10).
        const { handleOperatorDatesText } = await import('@/lib/operators/chat-dates/flow');
        const handled = await handleOperatorDatesText({
          chatId, sourceMid: msg.body.mid ?? null, text, partner: lookup.partner, send: datesSend(chatId), dialog,
          sentAtMs: Number.isFinite(update.timestamp) ? update.timestamp : null,
        });
        if (handled) return;
        const { handleRentalCalendarText } = await import('@/lib/rental/car-calendar-flow');
        const calendar = await handleRentalCalendarText({
          partner: lookup.partner,
          text,
          nowMs: Date.now(),
          dialog,
          canMark: true,
          send: rentalCalendarSend(chatId),
        });
        if (calendar) return;
        const { processPartnerMessage } = await import('@/lib/kuzmich/operator-chat');
        await processPartnerMessage({ chatId, text, fromName: userName, partner: lookup.partner, reply: maxReply });
        return;
      }

      await deliverTouristText({
        chatId, text, userName, userId,
        verifiedOrigin: opts?.verifiedOrigin,
        reply: maxReply,
        replyButtons: maxReplyWithButtons,
      });
    }
    return;
  }

  // message_callback → нажатие inline-кнопки
  if (update.update_type === 'message_callback' && update.callback) {
    const api = getApi();
    if (!api) return;

    const payload = update.callback.payload ?? '';
    // Чат сообщения с кнопкой. Для кнопки-действия — единственный источник
    // чата: у заверенного апдейта его назвал MAX, и по нему решается право
    // нажатия; user_id нажавшего этого права не даёт.
    const messageChatId: number | null = update.message?.recipient.chat_id ?? null;

    // Подтверждаем получение. Без второго аргумента намеренно: раньше сюда
    // передавалось `notification: ''` — пустое всплывающее уведомление, то
    // есть «показать ничего». В @maxhub/max-bot-api 0.3.0 поле `notification`
    // из AnswerOnCallbackExtra УДАЛЕНО, и обновление до 0.3.1 (PR #1715)
    // упиралось ровно в эту строку: 19 пакетов ждали одного поля, которого
    // больше нет. Вызов без extra делает то же самое — подтверждает callback
    // и ничего не показывает — и компилируется в обеих версиях.
    await api.answerOnCallback(update.callback.callback_id)
      .catch((err: unknown) => logFailure('подтверждение нажатия', err));

    // Кнопки-действия: ответ на запрос мест и кнопки лида.
    const pressAction = pressActionOf(payload);
    if (pressAction !== null) {
      const presserId = typeof update.callback.user?.user_id === 'number' ? update.callback.user.user_id : null;
      const chatType = typeof update.message?.recipient.chat_type === 'string' ? update.message.recipient.chat_type : null;
      const mid = typeof update.message?.body?.mid === 'string' ? update.message.body.mid : null;
      const pressed = mid ? { mid, text: update.message?.body?.text ?? null } : null;
      await handleActionPress(pressAction, payload, messageChatId, opts?.verifiedOrigin === true, presserId, chatType, pressed);
      return;
    }

    // Кнопки без последствий — только ответ в чат. Сообщения нет (его успели
    // удалить) — заверенному отвечаем в личный чат нажавшего (DM = user_id в
    // MAX). Незаверенному — только в чат сообщения: это не защита (чат в теле
    // подделывается так же, как user_id), а отказ добавлять второе поле, по
    // которому тело выбирает адресата. Группы и каналы (отрицательный чат) —
    // мимо, как у сообщений выше: темы и заявка — разговор в личном чате.
    const resolvedChatId = messageChatId ?? (opts?.verifiedOrigin === true ? update.callback.user.user_id : null);
    if (!resolvedChatId || resolvedChatId < 0) return;

    const userName = update.callback.user.name;
    const userId = update.callback.user.user_id;

    // Топик-кнопки → шлём как обычный запрос
    if (payload in TOPIC_TEXTS) {
      const topicText = TOPIC_TEXTS[payload];
      let capturedReply = '';
      const capturingReply = async (id: number, msg: string) => {
        capturedReply = msg;
        await maxReply(id, msg);
      };
      await processMessage({
        chatId: resolvedChatId, text: topicText, userName, userId,
        mode: 'max', createdVia: 'max', pending, reply: capturingReply,
        platform: 'max',
        verifiedOrigin: opts?.verifiedOrigin === true,
      });
      if (offersBooking(opts?.verifiedOrigin === true, capturedReply)) {
        await maxReplyWithButtons(resolvedChatId, 'Хотите оформить заявку?', BOOKING_BUTTONS);
      }
      return;
    }

    // Кнопка "Оформить заявку". Без заверенного апдейта оба пути после неё —
    // присланный номер и бронь в чате — закрыты; сказать это сразу честнее,
    // чем попросить номер и потом его не засчитать.
    if (payload === 'book_now' && opts?.verifiedOrigin !== true) {
      await maxReply(resolvedChatId, UNVERIFIED_CHAT_REPLY.booking);
      return;
    }
    if (payload === 'book_now') {
      await maxReplyWithButtons(
        resolvedChatId,
        'Поделитесь номером телефона — оператор свяжется в течение <b>1-2 часов</b>.',
        CONTACT_REQUEST_BUTTONS,
      );
      return;
    }

    // Пропустить → заявка через чат
    if (payload === 'skip_contact') {
      await processMessage({
        chatId: resolvedChatId,
        text: 'Хочу оформить заявку на тур',
        userName, userId,
        mode: 'max', createdVia: 'max', pending, reply: maxReply,
        platform: 'max',
        verifiedOrigin: opts?.verifiedOrigin === true,
      });
      return;
    }

    // Кнопка "Другой вариант"
    if (payload === 'other_tour') {
      await maxReplyWithButtons(resolvedChatId, 'Хорошо! Выберите тему, и я подберу что-то ещё:', START_MENU);
      return;
    }
  }
}

// ── POST: Webhook endpoint ────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Ответ MAX — всегда 200, как и раньше: после серии ошибок MAX может снять
  // подписку (шапка /api/cron/max-webhook). Отказ при этом не глушится — он в логе.
  let updates: MaxUpdate[] = [];
  try {
    const body: unknown = await request.json();
    // MAX может отправить один апдейт или массив
    updates = (Array.isArray(body) ? body : [body]) as MaxUpdate[];
  } catch (err) {
    logFailure('разбор тела апдейта', err);
    return NextResponse.json({ ok: true });
  }

  // Источник заверен, если запрос пришёл на адрес подписки с ключом, который
  // знаем только мы и MAX (см. lib/max/webhook-url).
  const verifiedOrigin = isVerifiedMaxWebhook(request.url);

  if (!verifiedOrigin) {
    const kind = updates.length > 0 ? updateKind(updates[0]) : 'пусто';
    // Ключ задан: MAX зовёт адрес с ним, и настоящая копия этого апдейта
    // пришла по ключу. Без ключа приходят только подделка или старая подписка
    // без ключа (вторая, которую крон видит с 30.09). Её копия не делает
    // ничего: ни ответа (он спорил бы с ответом настоящей копии), ни записи,
    // ни вызова модели. В лог — откуда пришла, чтобы подписку было видно.
    if (maxWebhookKeyConfigured()) {
      console.error(
        `[max/kuzmich] запрос без ключа подписки при заданном ключе — не обработан (${requestOrigin(request)}; `
        + `апдейтов ${updates.length}, первый — ${kind})`,
      );
      return NextResponse.json({ ok: true });
    }
    // Ключа нет — вопросы Кузьмичу из любого источника, но по одному апдейту
    // на запрос: MAX шлёт апдейты по одному, а пачку в тысячи апдейтов
    // прислала бы только подделка, и каждый из них — ход модели на наши ключи.
    if (updates.length !== 1) {
      console.error(
        `[max/kuzmich] пачка из ${updates.length} апдейтов без ключа подписки — не обработана (первый — ${kind})`,
      );
      return NextResponse.json({ ok: true });
    }
  }

  // Каждый апдейт — в своей обёртке: сбой одного не съедает остальные.
  for (const update of updates) {
    try {
      await handleUpdate(update, { verifiedOrigin });
    } catch (err) {
      logFailure(`обработка апдейта ${updateKind(update)}`, err);
    }
  }

  return NextResponse.json({ ok: true });
}

// ── GET: Long-polling endpoint (для cron или dev) ─────────────────────────────

export async function GET(): Promise<NextResponse> {
  const api = getApi();
  if (!api) {
    return NextResponse.json({ error: 'MAX_BOT_TOKEN not set' }, { status: 500 });
  }

  try {
    const extra: Record<string, unknown> = { limit: 50, timeout: 1 };
    if (pollingMarker) extra.marker = pollingMarker;

    const response = await api.getUpdates(
      ['message_created', 'bot_started', 'message_callback'],
      extra as Parameters<typeof api.getUpdates>[1],
    );

    pollingMarker = response.marker;

    let processed = 0;
    for (const update of response.updates) {
      // Long-polling заверен по построению: апдейты забрали мы сами у MAX
      // по токену бота — форжить тут нечего.
      await handleUpdate(update as unknown as MaxUpdate, { verifiedOrigin: true });
      processed++;
    }

    return NextResponse.json({
      ok: true,
      processed,
      marker: pollingMarker,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
