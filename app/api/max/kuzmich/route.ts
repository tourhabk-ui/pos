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
 * в чате кабинета туроператора и, с 29.10, гида со своими турами —
 * предложение с кнопками «Открыть» / «Не надо» (`od:`), запись — только по
 * нажатию. И фраза, и нажатие — только по
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
import { type PendingBooking, cleanupPending, hasLiveBookingFlow, processMessage } from '@/lib/kuzmich/core';
import { boundChatContext, boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { detectEmergency, withSosBlock } from '@/lib/safety/sos-detector';
import { PARTNER_EMAIL_BIND_CLOSED, findPartnerByChat } from '@/lib/kuzmich/operator-chat';
import { escapeHtml } from '@/lib/text/escape-html';
import { adminChatYieldsToPartner } from '@/lib/roles/admin-partner-chat';
import { isRentalPilotSlug, rentalPilotGreeting } from '@/lib/rental/operator-pilot';
import {
  parseRentalCabinetPress, rentalCabinetAsk, rentalCabinetBar, withRentalCabinetBar, type CabinetButton,
} from '@/lib/rental/cabinet-bar';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import { adminMenu, menuRoleOf, parseRoleMenuPress, partnerMenu, roleMenuAsk } from '@/lib/roles/role-menu';
import { PARTNER_PD_UNDELIVERED, roleMenuScreen, type RoleScreen } from '@/lib/roles/role-screen';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { openRentalCabinetScreen } from '@/lib/rental/cabinet-screen';
import { pool } from '@/lib/db-pool';
import { createLead } from '@/lib/leads/create';
import { claimMaxLoginSession, confirmMaxLoginSession, rejectMaxLoginSession } from '@/lib/auth/max-login';
import { isVerifiedMaxWebhook } from '@/lib/max/webhook-url';
import { applyLeadStatus, parseLeadStatusPayload } from '@/lib/leads/status-action';
import { bindPartnerChannel, boundMenuRow, channelBoundText, handlePartnerStart } from '@/lib/partners/bind-channel';
import { partnerLinkArgFromText } from '@/lib/partners/channel-link';
import { bindCodeMissedText, bindCodeRenewUrl, consumeBindCode, normalizeBindCode } from '@/lib/partners/bind-code';
import { handleMemberStart } from '@/lib/operators/member-channel';
import { ADMIN_MAX_TEXT, findMaxAdmin, handleAdminStart } from '@/lib/max/admin-link';
import { parseAnswerPayload, operatorReplyText, statusTokenFromStart, touristBindReplyText } from '@/lib/seat-requests/core';
import { answerSeatRequest, requestBelongsToMaxChat, bindTouristChat } from '@/lib/seat-requests/service';
import {
  type MaxPressAction, LOGIN_CONFIRM_PREFIX, LOGIN_REJECT_PREFIX, MAX_LOGIN_TEXT,
  PRESS_WITHOUT_MESSAGE_REPLY, UNVERIFIED_CHAT_REPLY, UNVERIFIED_PRESS_REPLY,
  UNVERIFIED_START_REPLY, maxWebhookKeyConfigured, pressActionOf, startActionOf,
} from '@/lib/max/verified-press';
import { chatActionsEnabledFor } from '@/lib/bookings/chat-owner-press';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { FLOW_TEXT as DATES_TEXT } from '@/lib/operators/chat-dates/texts';
import type { DatesSend } from '@/lib/operators/chat-dates/flow';
import { scrubErrorText } from '@/lib/client-errors/scrub';
import { isRepeatedMaxMessage } from '@/lib/max/update-dedup';
import { armChatWait, bindGuestChat, captureChatText, type ChatReply } from '@/lib/requests/request-chat-service';
import { guestKeyFromStart, parseChatPress } from '@/lib/requests/request-chat';
import { operatorDeskButtons, operatorHelpText, operatorSeatsText, operatorToursReply, loadOperatorTours } from '@/lib/telegram/operator-desk';
import { isOperatorDeskPayload, operatorDeskPress, operatorHelpPress } from '@/lib/telegram/operator-desk-press';
import { cabinetSectionFor, captureCabinetSearch, dropCabinetSearch, type CabinetSection } from '@/lib/chat-cabinet/service';
import { memberCabinetText } from '@/lib/chat-cabinet/member-entry';
import { cabinetPressEdits } from '@/lib/chat-cabinet/payload';
import { deliverCabinetMax, type MaxCabinetApi } from '@/lib/chat-cabinet/max-deliver';
import type { CabinetScreen } from '@/lib/chat-cabinet/screens';
import { isCabinetSection } from '@/lib/roles/role-screen';

type ButtonIntent = 'default' | 'positive' | 'negative';

function toMaxButtons(rows: CabinetButton[][]): MaxButton[][] {
  return rows.map((row) => row.map((b) => (
    b.intent
      ? { type: 'callback' as const, text: b.text, payload: b.payload, intent: b.intent }
      : { type: 'callback' as const, text: b.text, payload: b.payload }
  )));
}

/** Строка кабинета — последней, под кнопками самого ответа. */
function maxCabinetButtons(content: CabinetButton[][]): MaxButton[][] {
  return toMaxButtons(withRentalCabinetBar(content));
}

/**
 * Ответы переписки по заявке (1349, 1350): у каждого — свои кнопки
 * «Ответить гостю/клиенту» / «Написать …», по одной в строке.
 */
async function sendChatReplies(chatId: number, replies: ChatReply[]): Promise<void> {
  for (const r of replies) {
    const rows: MaxButton[][] = r.buttons.map((b) => ('url' in b
      ? [{ type: 'link' as const, text: b.text, url: b.url }]
      : [{ type: 'callback' as const, text: b.text, payload: b.payload }]));
    if (rows.length) await maxReplyWithButtons(chatId, r.text, rows);
    else await maxReply(chatId, r.text);
  }
}

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

/**
 * Экран меню партнёра в чат MAX. С ПД (брони гида — имя и телефон туриста)
 * — только через sendPdAlert и только в этот чат MAX: `telegramChatId: null`,
 * заглушки в Telegram нет. Не доставилось — строка без ПД. Без ПД — обычный
 * ответ со строкой меню. `wrap` — блок 112, если в тексте человека беда.
 */
async function sendPartnerScreen(
  chatId: number,
  screen: RoleScreen,
  row: MenuButton[],
  wrap: (body: string) => string = (body) => body,
): Promise<void> {
  // Кнопки действий экрана (бронь гида: вопрос, затем «Да») — над строкой меню.
  // Строки меню нет — чат не личный диалог, и кнопки действий не ставятся.
  const actions = row.length ? (screen.buttons ?? []) : [];
  const rows = row.length ? appendMenu(actions, row) : [];
  if (!screen.pd) {
    if (rows.length) await maxReplyWithButtons(chatId, wrap(screen.text), toMaxButtons(rows));
    else await maxReply(chatId, wrap(screen.text));
    return;
  }
  const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
  const sent = await sendPdAlert({
    text: wrap(screen.text),
    stub: 'Список с контактами туристов в MAX не доставлен.',
    buttons: rows.flat(),
    to: { maxChatId: chatId, telegramChatId: null },
  });
  if (!sent.delivered) {
    console.error('[max/kuzmich] экран с ПД партнёру не доставлен:', sent.reason);
    await maxReplyWithButtons(chatId, wrap(PARTNER_PD_UNDELIVERED), toMaxButtons(row.length ? [row] : []));
  }
}

/**
 * Ответ «Беру» / «Не могу»: правим то же сообщение и снимаем кнопки заявки.
 * У пилота на их месте остаётся строка кабинета; у перевозчика (#2862) —
 * кнопка «Ответить клиенту» (`keep`), чтобы переписка с заказчиком не
 * пропала вместе с кнопками ответа.
 */
function rentalAnswerSend(chatId: number, bar: boolean) {
  return async (text: string, editMid: string | null, keep?: Array<{ text: string; payload: string }>): Promise<void> => {
    const keepRows = keep && keep.length ? [keep] : [];
    const buttons = bar ? maxCabinetButtons(keepRows) : toMaxButtons(keepRows);
    const api = getApi();
    const attachments = buttons.length
      ? [{ type: 'inline_keyboard', payload: { buttons } }]
      : [];
    if (editMid && api) {
      try {
        const res = await (api.editMessage as (id: string, extra: unknown) => Promise<{ success?: boolean }>)(editMid, {
          text,
          format: 'html',
          attachments,
        });
        if (res?.success !== false) return;
        console.error('[max/kuzmich] правка ответа на заявку проката не принята MAX — отправляю новым сообщением');
      } catch (err) {
        logFailure('правка ответа на заявку проката', err);
      }
    }
    if (buttons.length) await maxReplyWithButtons(chatId, text, buttons);
    else await maxReply(chatId, text);
  };
}

/** Календарь проката: правим то же сообщение, иначе шлём новое. Кнопки — `rb:`. */
function rentalCalendarSend(chatId: number, bar: boolean) {
  return async (
    text: string,
    buttons: Array<Array<{ text: string; payload: string; intent?: 'positive' | 'negative' }>>,
    editMid: string | null,
  ): Promise<void> => {
    const rows = bar ? maxCabinetButtons(buttons) : toMaxButtons(buttons);
    const api = getApi();
    if (editMid && api && rows.length > 0) {
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

/**
 * Экран кабинета в чате: правка сообщения с кнопкой или новое сообщение, блок
 * 112 — отдельным сообщением перед экраном (lib/chat-cabinet/max-deliver).
 */
async function showCabinetMax(
  chatId: number,
  screen: CabinetScreen,
  editMid: string | null,
  userText?: string,
): Promise<void> {
  const api = getApi();
  if (!api) return;
  await deliverCabinetMax(api as unknown as MaxCabinetApi, chatId, screen, editMid, userText);
}

/** Раздел кабинета по слову или команде: «Входящие», /requests, «Задачи», «Клиенты». */
function cabinetSectionOfText(asked: ReturnType<typeof roleMenuAsk>, slashHead: string): CabinetSection | null {
  if (asked === 'inbox' || slashHead === '/requests') return 'inbox';
  if (asked === 'tasks' || slashHead === '/tasks') return 'tasks';
  if (asked === 'clients' || slashHead === '/clients') return 'clients';
  return null;
}

const CABINET_IN_DIALOG = 'Кабинет в чате открывается в личном диалоге с ботом: в группе кнопки нажал бы любой участник.';

/**
 * Личный диалог, который не чат карточки: может быть чатом менеджера команды
 * (lib/chat-cabinet/member-entry). true — ответ дан; false — текст идёт
 * дальше своим путём.
 */
function memberCabinetMax(chatId: number, text: string): Promise<boolean> {
  return memberCabinetText({ channel: 'max', chatId, text }, {
    show: (screen, userText) => showCabinetMax(chatId, screen, null, userText),
    say: (body) => maxReply(chatId, body),
  });
}

/** Ответ потока дат в чат кабинета: кнопки — callback с payload `od:`. */
function datesSend(chatId: number, menu: MenuButton[] | null): DatesSend {
  return async (text, buttons) => {
    const rows = menu?.length
      ? toMaxButtons(appendMenu(buttons ?? [], menu))
      : toMaxButtons(buttons ?? []);
    if (rows.length === 0) {
      await maxReply(chatId, text);
      return;
    }
    await maxReplyWithButtons(chatId, text, rows);
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
function offersBooking(verified: boolean, reply: string, question: string): boolean {
  // После блока 112 кнопок брони нет: совет при пропаже группы называет
  // «маршрут», и «Хотите оформить заявку?» вставало прямо под тревогой.
  if (detectEmergency(question).detected) return false;
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
  if (offersBooking(verified, capturedReply, opts.text)) {
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

/** Ответ партнёру на карточку контакта в его привязанном чате. */
function partnerContactReply(partnerName: string): string {
  return `Это чат кабинета «${escapeHtml(partnerName)}». Карточку контакта заявкой не делаю: `
    + 'номер вашего клиента ушёл бы в общую очередь заявок платформы, а оттуда — другим партнёрам. '
    + 'Касание с клиентом, который уже есть в CRM, запишите словами: «запиши звонок Анне, договорились на 15-е».';
}

/** База не ответила, чей это чат: номер не принимаем, чтобы не отдать чужого клиента в общую очередь. */
const PARTNER_CONTACT_UNCHECKED =
  'Номер не принят: не удалось проверить, чей это чат. Напишите через минуту. В беде — звоните 112.';

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
 *     кабинета продавца своих туров (туроператор, гид с турами), чьё это
 *     предложение (lib/operators/chat-dates), для «Выполнено» — личный диалог
 *     кабинета, чья это задача (lib/crm/chat-task-action).
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

  // Бронь и заявка своего тура кнопкой (гид, 29.10): вопрос `bk:` / `ld:`,
  // затем «Да» / «Не надо» `oc:`. Личный диалог, карточка чата, аккаунт,
  // человек привязки и владение бронью и заявкой проверяет
  // lib/bookings/chat-owner-action; нажавший — из заверенного апдейта (его
  // user_id прислал MAX).
  if (action === 'owner') {
    const { handleOwnerPress } = await import('@/lib/bookings/chat-owner-action');
    const reply = await handleOwnerPress({
      channel: 'max', chatId, privateChat: chatType === 'dialog', presserId, payload,
    });
    if (reply.buttons.length) await maxReplyWithButtons(chatId, reply.text, toMaxButtons(reply.buttons));
    else await maxReply(chatId, reply.text);
    return;
  }

  // Кабинет в чате (30.10): экран правит сообщение с кнопкой. Личный диалог,
  // карточку чата и владение задачей и клиентом проверяет lib/chat-cabinet.
  if (action === 'cabinet') {
    const { handleCabinetPress } = await import('@/lib/chat-cabinet/service');
    const screen = await handleCabinetPress({ channel: 'max', chatId, privateChat: chatType === 'dialog', payload });
    await showCabinetMax(chatId, screen, cabinetPressEdits(payload) ? (pressed?.mid ?? null) : null);
    return;
  }

  // «Выполнено» под напоминанием о задаче CRM (29.10). Личный диалог и то,
  // что задача — карточки, к которой подключён этот чат, проверяет
  // lib/crm/chat-task-action; отмечает тот же completeTask, что кабинет.
  if (action === 'task') {
    const { handleTaskPress } = await import('@/lib/crm/chat-task-action');
    await maxReply(chatId, await handleTaskPress({ chatId, privateChat: chatType === 'dialog', payload }));
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
    const menu = lookup.outcome === 'found'
      ? (isRentalPilotSlug(lookup.partner.slug) ? rentalCabinetBar() : partnerMenu(lookup.partner))
      : null;
    await handleOperatorDatesPress({ payload, chatId, lookup, send: datesSend(chatId, menu) });
    return;
  }

  // Календарь проката (`rb:`) и ответ на заявку (`rr:`). Только личный диалог
  // и только чат привязанного пилота. Чужой payload машину не отмечает.
  if (action === 'rental') {
    if (chatType !== 'dialog') {
      console.error(`[max/kuzmich] нажатие (rental) не из личного диалога (${chatTypeForLog(chatType)}) — не применено`);
      const line = payload.startsWith('rr:') || payload.startsWith('rc:')
        ? 'Ответ на заявку принимается в личном диалоге с ботом. Здесь ничего не записал.'
        : 'Календарь проката отмечается в личном диалоге с ботом. Отметка не записана.';
      await maxReply(chatId, line);
      return;
    }
    const lookup = await findPartnerByChat('max', chatId);
    const bar = lookup.outcome === 'found' && isRentalPilotSlug(lookup.partner.slug);
    // Исход поездки перевозчика (#2862 этап B): тот же способ ответа, что у «Беру» / «Не могу».
    if (payload.startsWith('rc:')) {
      const { handleRideOutcomePress } = await import('@/lib/transfers/ride-outcome-flow');
      await handleRideOutcomePress({
        lookup,
        payload,
        editMid: pressed?.mid ?? null,
        originalText: pressed?.text ?? null,
        via: 'max',
        send: rentalAnswerSend(chatId, bar),
      });
      return;
    }
    if (payload.startsWith('rr:')) {
      const { handleRentalRequestAnswer } = await import('@/lib/rental/request-answer-flow');
      await handleRentalRequestAnswer({
        lookup,
        payload,
        editMid: pressed?.mid ?? null,
        originalText: pressed?.text ?? null,
        via: 'max',
        send: rentalAnswerSend(chatId, bar),
      });
      return;
    }
    const { handleRentalCalendarPress } = await import('@/lib/rental/car-calendar-flow');
    await handleRentalCalendarPress({
      lookup, payload, nowMs: Date.now(), editMid: pressed?.mid ?? null, send: rentalCalendarSend(chatId, bar),
    });
    return;
  }

  // Переписка по заявке (1349, 1350): «Ответить гостю/клиенту» у адресата,
  // «Написать …» у клиента. Только личный диалог; право чата на заявку (чат
  // партнёра-адресата или подключённый чат клиента) и ожидание следующего
  // сообщения — lib/requests/request-chat-service.
  if (action === 'request_chat') {
    if (chatType !== 'dialog') {
      console.error(`[max/kuzmich] нажатие (request_chat) не из личного диалога (${chatTypeForLog(chatType)}) — не применено`);
      await maxReply(chatId, 'Переписка по заявке идёт в личном диалоге с ботом. Здесь ничего не отправлено.');
      return;
    }
    const press = parseChatPress(payload);
    if (!press) {
      await maxReply(chatId, 'Кнопка не распознана — ничего не отправлено. Позвоните по телефону из заявки.');
      return;
    }
    await sendChatReplies(chatId, [await armChatWait(press.side, press.target, chatId)]);
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
      // Клиент подключает свой чат к заявке с перепиской (1349, 1350): ответы
      // адресата придут сюда. Ворота — ключ статуса заявки (хэш в базе),
      // открывающий переписку.
      const chatKey = guestKeyFromStart(startArg);
      if (chatKey !== null) {
        await sendChatReplies(update.chat_id, await bindGuestChat(chatKey, update.chat_id));
        return;
      }
      const seatToken = statusTokenFromStart(startArg);
      if (seatToken !== null) {
        // Турист хочет получить ответ оператора на запрос мест сюда.
        const bound = await bindTouristChat(seatToken, 'max', update.chat_id);
        await maxReply(update.chat_id, touristBindReplyText(bound));
        return;
      }

      const chatId = update.chat_id;
      if (normalizeBindCode(startArg)) {
        const consumed = await consumeBindCode(startArg, 'max', chatId);
        if (!consumed.ok) {
          console.error(`[max/kuzmich] код привязки не подошёл: ${consumed.reason}`);
          const missed = consumed.reason === 'db_error'
            ? 'Не удалось проверить код — база не ответила. Попробуйте через несколько минут.'
            : bindCodeMissedText();
          await maxReplyWithButtons(chatId, missed, [[{ type: 'link', text: 'Получить новый', url: bindCodeRenewUrl() }]]);
          return;
        }
        // Кто нажал «Старт» — для входа на сайт через MAX (1336): bot_started
        // приходит из личного диалога, человек — user_id апдейта.
        const codeStarter = typeof update.user?.user_id === 'number' ? update.user.user_id : null;
        const bound = await bindPartnerChannel(consumed.partnerId, 'max', chatId, codeStarter);
        if (!bound.ok) {
          console.error(`[max/kuzmich] код принят, карточка не записана: ${bound.reason}`);
          await maxReplyWithButtons(chatId, 'Не удалось сохранить привязку. Нажмите «Получить новый».', [[{ type: 'link', text: 'Получить новый', url: bindCodeRenewUrl() }]]);
          return;
        }
        const text = channelBoundText('max', bound);
        const pilot = bound.ok && isRentalPilotSlug(bound.slug);
        const desk = bound.ok && bound.category === 'operator' && !pilot;
        // Гид — его строка меню (продавцу своих туров — с «Бронями» и «Моими турами»).
        const guideRow = boundMenuRow(bound);
        const buttons = pilot
          ? toMaxButtons([rentalCabinetBar()])
          : desk
            ? toMaxButtons(operatorDeskButtons())
            : guideRow
              ? toMaxButtons([guideRow])
              : null;
        if (buttons) await maxReplyWithButtons(chatId, text, buttons);
        else await maxReply(chatId, text);
        return;
      }
      // Администратор подключает свой MAX одноразовой ссылкой из админки
      // (lib/max/admin-link, слово владельца 23.10). Привязывается человек —
      // user_id апдейта, без отката на id чата.
      const starterId = typeof update.user?.user_id === 'number' ? update.user.user_id : null;
      if (await handleAdminStart(startArg, starterId, (text) => maxReply(chatId, text))) return;
      if (await handlePartnerStart(startArg, 'max', chatId, async (text, buttons) => {
        if (buttons?.length) await maxReplyWithButtons(chatId, text, toMaxButtons(buttons.map((row) => [...row])));
        else await maxReply(chatId, text);
      }, starterId)) return;
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
        await maxReplyWithButtons(update.chat_id, adminGreeting(admin.name), toMaxButtons([adminMenu()]));
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
        await maxReplyWithButtons(update.chat_id, rentalPilotGreeting(boundPilot.partner.partnerName), maxCabinetButtons([]));
        return;
      }
      if (boundPilot.outcome === 'found') {
        const role = menuRoleOf(boundPilot.partner);
        const row = partnerMenu(boundPilot.partner);
        if (role === 'operator' && row) {
          await maxReplyWithButtons(update.chat_id, operatorHelpText(), toMaxButtons(operatorDeskButtons()));
          return;
        }
        if (role && row) {
          const screen = await roleMenuScreen({
            role, action: 'help', channel: 'max', partner: boundPilot.partner, nowMs: Date.now(),
          });
          await maxReplyWithButtons(update.chat_id, screen.text, toMaxButtons([row]));
          return;
        }
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
    // Повтор того же сообщения (MAX доставил апдейт второй раз, пока шёл цикл
    // модели) не отвечается и не пишется в CRM второй раз (25.10).
    if (typeof msg.body.mid === 'string' && msg.body.mid !== ''
      && isRepeatedMaxMessage(msg.body.mid, opts?.verifiedOrigin === true)) return;

    const text = msg.body.text?.trim() ?? '';
    const attachments = msg.body.attachments ?? [];
    const userName = msg.sender?.name ?? null;
    const userId = msg.sender?.user_id ?? null;

    // Код привязки оператора, набранный в чате. web.max.ru не кладёт ?start=
    // в payload bot_started, и «/start op_…» или голое «op_…» иначе уходили
    // в приветствие Кузьмича. Та же цепочка, что у payload: подпись и запись
    // в handlePartnerStart, и только из заверенного апдейта. Вложение с
    // подписью-кодом сюда не берём — это фото или контакт, не команда.
    const linkArg = msg.recipient.chat_type === 'dialog' && attachments.length === 0
      ? partnerLinkArgFromText(text)
      : null;
    if (linkArg !== null) {
      if (opts?.verifiedOrigin === true) {
        // Код набран в личном диалоге — человек, открывший ссылку, известен (1336).
        if (await handlePartnerStart(linkArg, 'max', chatId, async (replyText, buttons) => {
          if (buttons?.length) await maxReplyWithButtons(chatId, replyText, toMaxButtons(buttons.map((row) => [...row])));
          else await maxReply(chatId, replyText);
        }, typeof userId === 'number' ? userId : null)) return;
      } else {
        console.error('[max/kuzmich] код привязки оператора из незаверенного апдейта — не применён');
        await maxReply(chatId, UNVERIFIED_START_REPLY.link);
        return;
      }
    }

    // ── ПЕРЕПИСКА ПО ЗАЯВКЕ (1349, 1350) ─────────────────────────────────
    // Раньше всех веток, но только в личном диалоге, только текстом и только
    // по заверенному апдейту. Ссылка клиента, набранная текстом (web.max.ru не
    // кладёт ?start= в апдейт), подключает чат к заявке. Иначе: если чат после
    // кнопки «Ответить гостю/клиенту» / «Написать …» ждёт сообщение — оно
    // уходит второй стороне; не ждёт — дальше обычным путём, и «запиши звонок»
    // адресата клиенту не уйдёт.
    if (opts?.verifiedOrigin === true && msg.recipient.chat_type === 'dialog' && attachments.length === 0 && text) {
      const typedChatKey = guestKeyFromStart(text);
      if (typedChatKey !== null) {
        await sendChatReplies(chatId, await bindGuestChat(typedChatKey, chatId));
        return;
      }
      const relayed = await captureChatText(chatId, text);
      if (relayed) {
        // Беда в тексте — блок 112 над ответом: сообщение ушло второй стороне,
        // но помощь сейчас — не адресат заявки, а 112.
        await sendChatReplies(chatId, [{ ...relayed, text: withSosBlock(relayed.text, text).text }]);
        return;
      }
    }

    // ── АДМИНИСТРАТОР (слово владельца 23.10) ─────────────────────────────
    // Раньше всех веток: вложения ниже создали бы лид из номера
    // администратора и отправили бы голос в зарубежную модель, а помощник
    // партнёра забрал бы чат, если он ещё и привязан к карточке. Права —
    // заново на каждом сообщении (lib/max/admin-link): заверенный апдейт,
    // личный диалог, человек MAX привязан и его аккаунт сейчас владеет ролью
    // администратора. Группы и незаверенные апдейты базу здесь не трогают.
    if (opts?.verifiedOrigin === true && msg.recipient.chat_type === 'dialog' && typeof userId === 'number') {
      const admin = await findMaxAdmin(userId);
      // Заявка, начатая администратором у Кузьмича туриста, доводится им же:
      // имя, дата, контакт кнопкой иначе получали «Не понял команду» или
      // «только текст» (#2756).
      // Чат администратора бывает и чатом карточки партнёра: тогда консоль
      // берёт только свои команды, а кабинет партнёра — остальное (25.10).
      if (admin.outcome === 'admin' && !(await hasLiveBookingFlow(chatId, 'max', pending))
        && !(text && await adminChatYieldsToPartner('max', chatId, text))) {
        const { ADMIN_CHAT_TEXT, handleAdminMessage } = await import('@/lib/max/admin-chat');
        if (!text) {
          await maxReply(chatId, ADMIN_CHAT_TEXT.textOnly);
          return;
        }
        // Просьба туриста — Кузьмичу туриста раньше разбора команды.
        // Иначе «хочу забронировать тур» читается как «брони»: в команде
        // администратора подстрока «брон» где угодно. Кабинет («покажи брони»,
        // «даты», «сводка») классификатор оставляет кабинетом.
        // Беда — Кузьмичу туриста при любых словах: у администратора нет CRM,
        // и исключение «дело CRM остаётся кабинетом» ему не нужно.
        if (!/^\/start\b/i.test(text.trim()) && boundChatLaneFor('max', chatId, text, { admin: true }) === 'tourist') {
          await deliverTouristText({
            chatId, text, userName, userId, verifiedOrigin: opts?.verifiedOrigin, reply: maxReply, replyButtons: maxReplyWithButtons,
          });
          return;
        }
        await handleAdminMessage({
          text, name: admin.name, chatId,
          reply: async (_id, body) => {
            await maxReplyWithButtons(chatId, body, toMaxButtons([adminMenu()]));
          },
        });
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
      // Привязанный чат партнёра — его кабинет: карточка контакта там — это
      // его клиент, а не турист, оставивший свой номер. Заявка без адресата
      // через 2 часа уходит другим партнёрам (leads-followup) — с именем и
      // телефоном чужого клиента и без его согласия (проверка 25.10).
      const owner = await findPartnerByChat('max', chatId);
      if (owner.outcome === 'found') {
        await maxReply(chatId, partnerContactReply(owner.partner.partnerName));
        return;
      }
      if (owner.outcome === 'unavailable') {
        await maxReply(chatId, PARTNER_CONTACT_UNCHECKED);
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
      // Чат менеджера команды оператора (30.10): его кабинет в чате — слово
      // меню, команда, запрос поиска клиента. Прочий текст — как раньше.
      if (lookup.outcome === 'none' && dialog && opts?.verifiedOrigin === true && await memberCabinetMax(chatId, text)) {
        return;
      }
      const pilot = lookup.outcome === 'found' && isRentalPilotSlug(lookup.partner.slug);
      // В группе кнопку кабинета нажал бы любой участник. Меню — только в личном диалоге.
      const menu = lookup.outcome === 'found' && dialog
        ? (pilot ? rentalCabinetBar() : partnerMenu(lookup.partner))
        : null;
      // Беда в тексте привязанного чата — блок 112 над любым ответом этой
      // ветки, какая бы из них ни ответила (даты, календарь, сводка, кабинет):
      // классификатор отдаёт беду Кузьмичу туриста, но команда кабинета и
      // дело CRM в той же фразе остаются здесь (проверка качества 24.10).
      const emergency = detectEmergency(text).detected;
      const sos = (body: string): string => withSosBlock(body, text).text;
      const say = async (body: string) => {
        if (menu?.length) await maxReplyWithButtons(chatId, sos(body), toMaxButtons([menu]));
        else await maxReply(chatId, sos(body));
      };
      if (lookup.outcome !== 'none' && datesIntent === 'dates' && !dialog) {
        console.error(`[max/kuzmich] фраза про даты не из личного диалога (${chatTypeForLog(msg.recipient.chat_type)}) — без предложения`);
      }
      if (lookup.outcome === 'unavailable' && datesIntent === 'dates') {
        await maxReply(chatId, sos(DATES_TEXT.partnerUnknown));
        return;
      }
      // Причина отклонения брони (гид, 29.10): после «Отклонить» следующее
      // сообщение личного диалога — причина для туриста. Раньше полосы и
      // потока дат: «турист заболел» иначе ушло бы Кузьмичу туриста. Беда в
      // тексте — блок 112 над вопросом, как над любым ответом этой ветки.
      // Модуль действия грузится, только когда кнопки карточке включены.
      if (lookup.outcome === 'found' && dialog && opts?.verifiedOrigin === true && chatActionsEnabledFor(lookup.partner)) {
        const { captureOwnerReason } = await import('@/lib/bookings/chat-owner-action');
        const reason = await captureOwnerReason({ channel: 'max', chatId, partner: lookup.partner, text });
        if (reason) {
          await maxReplyWithButtons(chatId, sos(reason.text), toMaxButtons(reason.buttons));
          return;
        }
      }
      // Запрос поиска после кнопки «Найти клиента» (кабинет в чате, 30.10).
      // Беда и контроль выхода в тексте гасят ожидание сами — сообщение идёт
      // дальше своим путём; поиск уступает и кнопке, нажатой после него.
      if (lookup.outcome === 'found' && dialog && opts?.verifiedOrigin === true) {
        const found = await captureCabinetSearch({ chatId, partner: lookup.partner, text });
        if (found) {
          await showCabinetMax(chatId, found, null, text);
          return;
        }
      }
      // Просьба туриста в привязанном чате не уходит помощнику CRM: тот
      // отвечает про клиентов и свои туры и отказывает в аренде. Кабинет
      // (CRM, даты, календарь, прайс) — прежняя ветка, только по заверенному
      // апдейту. Незаверенная просьба туриста идёт Кузьмичу как обычный
      // вопрос, без записи в CRM.
      // Поток дат всё равно смотрит заверенную просьбу: «спланируй поездку
      // на 5 дней» — не команда открыть даты, но цифра в ней снимает
      // действующую кнопку «Открыть». Иначе старая кнопка пишет даты.
      // При беде поток дат не смотрит: «турист сломал ногу, закрой субботу»
      // получал ответ про даты без 112 и без Кузьмича.
      // Полоса — один раз на сообщение: у неё память о беде этого чата.
      // Живая заявка у Кузьмича туриста — ответы на её шаги тоже ему, мимо
      // потока дат: «15 июля» — дата заявки, а не открытие дат (#2756).
      const bookingLive = lookup.outcome === 'found' && await hasLiveBookingFlow(chatId, 'max', pending);
      const lane = lookup.outcome !== 'found' ? null
        : bookingLive ? 'tourist' as const
          : boundChatLaneFor('max', chatId, text, boundChatContext(lookup.partner));
      if (lookup.outcome === 'found' && !emergency && !bookingLive && lane === 'tourist' && opts?.verifiedOrigin === true) {
        const { handleOperatorDatesText } = await import('@/lib/operators/chat-dates/flow');
        const handled = await handleOperatorDatesText({
          chatId, sourceMid: msg.body.mid ?? null, text, partner: lookup.partner, send: datesSend(chatId, menu), dialog,
          sentAtMs: Number.isFinite(update.timestamp) ? update.timestamp : null,
        });
        if (handled) return;
      }
      if (lookup.outcome === 'found' && lane !== 'tourist') {
        // Помощник кабинета пишет в CRM партнёра (касания, задачи) — только по
        // заверенному апдейту: чат партнёра в теле прислал бы кто угодно.
        if (opts?.verifiedOrigin !== true) {
          console.error('[max/kuzmich] сообщение в чат партнёра из незаверенного апдейта — помощник не запущен');
          await maxReply(chatId, sos(UNVERIFIED_CHAT_REPLY.partner));
          return;
        }
        // «/сводка» — числа по запросам мест (пилот «Камчатская рыбалка»,
        // флаг по партнёру). Только числа, тур и дата — без ПД туриста.
        const summary = await import('@/lib/seat-requests/summary');
        if (summary.isSummaryCommand(text) && summary.summaryEnabledFor(lookup.partner.partnerId)) {
          const read = await summary.readSeatSummary(lookup.partner.partnerId);
          await say(read === 'db_error' ? summary.SUMMARY_DB_ERROR : summary.summaryText(read));
          return;
        }
        // «Следующая заявка» — ожидающий запрос с ближайшим сроком, с кнопками.
        if (summary.summaryEnabledFor(lookup.partner.partnerId)) {
          const next = await import('@/lib/seat-requests/answer-edit');
          if (next.isNextCommand(text)) {
            const r = await next.readNextPending(lookup.partner.partnerId);
            if (r === 'db_error' || r === null) {
              await say(r === null ? next.NEXT_NONE : next.NEXT_DB_ERROR);
            } else {
              const { operatorAnswerUrl } = await import('@/lib/seat-requests/service');
              const card = next.nextRequestCard(r, operatorAnswerUrl(r.id));
              const rows = menu?.length
                ? [...card.buttons, ...toMaxButtons([menu])]
                : card.buttons;
              await maxReplyWithButtons(chatId, sos(card.text), rows);
            }
            return;
          }
        }
        // Поток дат смотрит каждое сообщение партнёра: не про даты — false, но
        // поправка («нет, 4 места»), ушедшая помощнику, снимает действующее
        // предложение туроператора (пятый ревью 22.10).
        const { handleOperatorDatesText } = await import('@/lib/operators/chat-dates/flow');
        const handled = await handleOperatorDatesText({
          chatId, sourceMid: msg.body.mid ?? null, text, partner: lookup.partner,
          send: (body, buttons) => datesSend(chatId, menu)(sos(body), buttons), dialog,
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
          send: (body, buttons, editMid) => rentalCalendarSend(chatId, pilot)(sos(body), buttons, editMid),
        });
        if (calendar) return;
        const role = menuRoleOf(lookup.partner);
        const askedRole = roleMenuAsk(text);
        const slashHead = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        // Туры и места — продавцу своих туров: туроператору и гиду с
        // авторскими турами. Гиду — его раздел «Свои туры», не кабинет
        // оператора (тот его не пустит). Меню — только в личном диалоге.
        if (role && sellsOwnTours(lookup.partner)
          && (askedRole === 'tours' || askedRole === 'seats' || slashHead === '/tours' || slashHead === '/seats')) {
          const which = askedRole === 'seats' || slashHead === '/seats' ? 'seats' : 'tours';
          if (role === 'guide') {
            if (which === 'seats') {
              await say(operatorSeatsText('guide'));
            } else {
              const screen = await roleMenuScreen({ role, action: 'tours', channel: 'max', partner: lookup.partner, nowMs: Date.now() });
              await sendPartnerScreen(chatId, screen, menu ?? [], sos);
            }
            return;
          }
          const body = which === 'tours'
            ? operatorToursReply(await loadOperatorTours(lookup.partner.partnerId))
            : operatorSeatsText();
          await say(body);
          return;
        }
        // «/bookings» — «Брони» гида со своими турами. Контакты туриста —
        // только через sendPdAlert и только в личном диалоге: в группе их
        // увидел бы любой участник.
        if (role === 'guide' && slashHead === '/bookings') {
          if (!dialog) {
            await say('Брони с контактами туристов показываю только в личном диалоге с ботом.');
            return;
          }
          const screen = await roleMenuScreen({ role, action: 'bookings', channel: 'max', partner: lookup.partner, nowMs: Date.now() });
          await sendPartnerScreen(chatId, screen, menu ?? [], sos);
          return;
        }
        if (role === 'operator' && (text.trim() === '/start' || slashHead === '/help' || askedRole === 'help')) {
          await maxReplyWithButtons(chatId, operatorHelpText(), toMaxButtons(operatorDeskButtons()));
          return;
        }
        // Кабинет в чате (30.10): «Входящие», «Задачи», «Клиенты» словом или
        // командой — раздел новым сообщением. Только в личном диалоге: в
        // группе кнопки карточек нажал бы любой участник, а в задачах и
        // клиентах — имена.
        const section = role ? cabinetSectionOfText(askedRole, slashHead) : null;
        if (role && section) {
          if (!dialog) {
            await say(CABINET_IN_DIALOG);
            return;
          }
          await showCabinetMax(chatId, await cabinetSectionFor(lookup.partner, 'max', section), null, text);
          return;
        }
        if (role && (text.trim() === '/start' || slashHead === '/help' || askedRole !== null)) {
          if (text.trim() === '/start' || slashHead === '/help' || askedRole === 'help') {
            const screen = await roleMenuScreen({
              role, action: 'help', channel: 'max', partner: lookup.partner, nowMs: Date.now(),
            });
            await sendPartnerScreen(chatId, screen, menu ?? [], sos);
            return;
          }
          // «Мои туры и цены» и «Обновить места» у того, кто своих туров не
          // продаёт, — его «Входящие», как раньше.
          if (!dialog) {
            await say(CABINET_IN_DIALOG);
            return;
          }
          await showCabinetMax(chatId, await cabinetSectionFor(lookup.partner, 'max', 'inbox'), null, text);
          return;
        }
        const asked = rentalCabinetAsk(text);
        if (pilot && (asked === 'requests' || asked === 'edits' || asked === 'help')) {
          await openRentalCabinetScreen({
            action: asked,
            partner: {
              partnerId: lookup.partner.partnerId,
              partnerName: lookup.partner.partnerName,
              slug: lookup.partner.slug,
            },
            channel: 'max',
            dialog,
            send: async (body, buttons) => {
              await maxReplyWithButtons(chatId, sos(body), maxCabinetButtons(buttons));
            },
          });
          return;
        }
        const { processPartnerMessage } = await import('@/lib/kuzmich/operator-chat');
        await processPartnerMessage({
          chatId, text, fromName: userName, partner: lookup.partner,
          reply: async (_id, body) => { await say(body); },
        });
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

    if (isOperatorDeskPayload(payload)) {
      if (opts?.verifiedOrigin !== true) {
        console.error('[max/kuzmich] кнопка кабинета туроператора из незаверенного апдейта — не выполнена');
        if (messageChatId) await maxReply(messageChatId, UNVERIFIED_CHAT_REPLY.partner);
        return;
      }
      if (!messageChatId) return;
      const desk = await operatorDeskPress({ channel: 'max', chatId: messageChatId, payload });
      if (desk) {
        if (desk.buttons.length) await maxReplyWithButtons(messageChatId, desk.text, toMaxButtons(desk.buttons));
        else await maxReply(messageChatId, desk.text);
      }
      return;
    }

    // Строка кабинета прокатчика. Не кнопка-действие с записью: она открывает
    // уже существующие чтения. Чат — только из сообщения с кнопкой.
    const barAction = parseRentalCabinetPress(payload);
    if (barAction) {
      const barPresserId = typeof update.callback.user?.user_id === 'number' ? update.callback.user.user_id : null;
      const barChatType = typeof update.message?.recipient.chat_type === 'string' ? update.message.recipient.chat_type : null;
      if (opts?.verifiedOrigin !== true) {
        console.error('[max/kuzmich] кнопка кабинета проката из незаверенного апдейта — не выполнена');
        if (messageChatId) await maxReply(messageChatId, UNVERIFIED_CHAT_REPLY.partner);
        return;
      }
      if (!messageChatId) {
        if (barPresserId) await maxReplyToUser(barPresserId, 'Кнопка кабинета проката без сообщения. Ничего не открыл.');
        return;
      }
      if (barChatType !== 'dialog') {
        await maxReply(messageChatId, 'Кнопки кабинета проката работают в личном диалоге.');
        return;
      }
      const barLookup = await findPartnerByChat('max', messageChatId);
      if (barLookup.outcome === 'unavailable') {
        await maxReply(messageChatId, 'Не удалось проверить, чей это чат. Кнопку не выполнил.');
        return;
      }
      if (barLookup.outcome !== 'found' || !isRentalPilotSlug(barLookup.partner.slug)) {
        await maxReply(messageChatId, 'Эта кнопка — кабинет проката. В этом чате её не выполняю.');
        return;
      }
      const barPartner = barLookup.partner;
      await openRentalCabinetScreen({
        action: barAction,
        partner: { partnerId: barPartner.partnerId, partnerName: barPartner.partnerName, slug: barPartner.slug },
        channel: 'max',
        dialog: true,
        send: async (text, buttons) => {
          await maxReplyWithButtons(messageChatId, text, maxCabinetButtons(buttons));
        },
      });
      return;
    }

    // Меню роли. Не пилот проката: у того свои rk:. Админ — по привязке
    // человека MAX, партнёр — по чату сообщения.
    const rolePress = parseRoleMenuPress(payload);
    if (rolePress) {
      const rolePresserId = typeof update.callback.user?.user_id === 'number' ? update.callback.user.user_id : null;
      const roleChatType = typeof update.message?.recipient.chat_type === 'string' ? update.message.recipient.chat_type : null;
      if (opts?.verifiedOrigin !== true) {
        console.error('[max/kuzmich] кнопка меню роли из незаверенного апдейта — не выполнена');
        if (messageChatId) await maxReply(messageChatId, UNVERIFIED_CHAT_REPLY.partner);
        return;
      }
      if (!messageChatId || roleChatType !== 'dialog') {
        const where = messageChatId ?? rolePresserId;
        if (where) await maxReply(where, 'Кнопки кабинета работают в личном диалоге.');
        return;
      }
      if (rolePress.role === 'admin') {
        const admin = rolePresserId === null ? { outcome: 'none' as const } : await findMaxAdmin(rolePresserId);
        // «Не смог проверить» — не «вы не администратор» (§4.0): кнопку не
        // выполняем и говорим, что роль не проверена, как в Telegram.
        if (admin.outcome === 'unavailable') {
          await maxReply(messageChatId, ADMIN_MAX_TEXT.unchecked);
          return;
        }
        if (admin.outcome !== 'admin') {
          await maxReply(messageChatId, ADMIN_MAX_TEXT.deny);
          return;
        }
        const screen = await roleMenuScreen({
          role: 'admin', action: rolePress.action, channel: 'max', partner: null, nowMs: Date.now(),
        });
        if (screen.pd) {
          const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
          const sent = await sendPdAlert({
            text: screen.text,
            stub: 'Ответ администратору в MAX не доставлен.',
            buttons: adminMenu(),
            to: { maxChatId: messageChatId, telegramChatId: null },
          });
          if (!sent.delivered) {
            console.error('[max/admin] ответ с ПД по кнопке не доставлен:', sent.reason);
            await maxReplyWithButtons(messageChatId, 'Ответ с контактами туристов не доставлен в MAX — откройте раздел в админке на vedarai.ru.', toMaxButtons([adminMenu()]));
          }
          return;
        }
        await maxReplyWithButtons(messageChatId, screen.text, toMaxButtons([adminMenu()]));
        return;
      }
      const roleLookup = await findPartnerByChat('max', messageChatId);
      if (roleLookup.outcome === 'unavailable') {
        await maxReply(messageChatId, 'Не удалось проверить, чей это чат. Кнопку не выполнил.');
        return;
      }
      if (roleLookup.outcome !== 'found' || menuRoleOf(roleLookup.partner) !== rolePress.role) {
        await maxReply(messageChatId, 'Эта кнопка — меню кабинета. В этом чате её не выполняю.');
        return;
      }
      // Кнопка меню — другая кнопка кабинета: ждущий поиск клиента снят.
      await dropCabinetSearch(messageChatId);
      // Вкладка кабинета в чате — раздел новым сообщением: строка меню стоит
      // и под уведомлениями, и править их нельзя.
      if (isCabinetSection(rolePress.action)) {
        await showCabinetMax(messageChatId, await cabinetSectionFor(roleLookup.partner, 'max', rolePress.action), null);
        return;
      }
      const row = partnerMenu(roleLookup.partner) ?? [];
      if (rolePress.role === 'operator' && rolePress.action === 'help') {
        const view = operatorHelpPress(row);
        await maxReplyWithButtons(messageChatId, view.text, toMaxButtons(view.buttons));
        return;
      }
      const screen = await roleMenuScreen({
        role: rolePress.role,
        action: rolePress.action,
        channel: 'max',
        partner: roleLookup.partner,
        nowMs: Date.now(),
      });
      await sendPartnerScreen(messageChatId, screen, row);
      return;
    }

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
      if (offersBooking(opts?.verifiedOrigin === true, capturedReply, topicText)) {
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
