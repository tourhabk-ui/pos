/**
 * POST /api/telegram/webhook
 *
 * Обработчик @kuzmichai_bot.
 *
 * Команды (публичные):
 *   /start     — приветствие
 *   /help      — список команд
 *   /route     — случайный маршрут из каталога
 *   /sezon     — AI-совет на текущий сезон
 *   /weather   — погода в Петропавловске-Камчатском
 *   /tip       — случайный совет путешественнику
 *   /operators — список партнёров
 *   <текст>    — Кузьмич: общий мозг lib/kuzmich/core (aiChat) с историей,
 *                инструментами, блоком 112 и чисткой телефонов и почт
 *
 * Admin:
 *   TELEGRAM_CHAT_ID — консоль (/stats, /post, статус заявки), если этот чат
 *   не забрала привязка администратора.
 *   Привязка из админки (adt_, lib/telegram/admin-link) — кабинет чтения
 *   с теми же кнопками, что в MAX. Контакты туристов сюда не отдаются.
 *   /stats              — статистика платформы
 *   /leads              — последние 5 заявок
 *   /digest             — AI дайджест платформы (лиды, брони, рекомендации)
 *   /agent <text>       — прямой запрос к PlatformAgent (любой intent)
 *   /post operator slug — публикация оператора в канал
 *   /post route uuid    — публикация маршрута в канал
 *   /post sezon         — AI генерирует сезонный пост в канал
 *
 * Безопасность: X-Telegram-Bot-Api-Secret-Token
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminChatYieldsToPartner } from '@/lib/roles/admin-partner-chat';
import { repairTelegramHtml, TELEGRAM_CAPTION_LIMIT } from '@/lib/notifications/telegram-html';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { telegramService } from '@/lib/notifications/telegram';
import { verifyWebhookSecret, refuseUnconfiguredWebhook } from '@/lib/telegram/webhook-secret';
import { isRepeatedTelegramUpdate } from '@/lib/telegram/update-dedup';
import { enqueueTelegramChat, telegramChatKey, webhookAwaitsHandler } from '@/lib/telegram/update-lane';
import { emphasizeTripDays, sanitizeForTelegram } from '@/lib/telegram/kuzmich-format';
import { matchTouristButton, touristReplyMarkup, touristRentalText, TOURIST_ASK_TEXT, type TouristButton } from '@/lib/telegram/tourist-keyboard';
import { catalogFacts, loadShowcaseTours } from '@/lib/telegram/tourist-tours';
import { touristOperatorsList } from '@/lib/telegram/operators-list';
import { telegramWatchRedirect } from '@/lib/kuzmich/watch-flow';
import { query } from '@/lib/database';
import { callAIWithModelDirect } from '@/lib/ai/providers';
import { getModelForAgent } from '@/lib/ai/agent-models';
import { type ChatMessage } from '@/lib/ai/prompts';
import { collapseRepeatedReply, requestButton, telegramOfferLinks } from '@/lib/kuzmich/answer-quality';
import { KUZMICH_SYSTEM, aiChat, getHistory, type ReplyFn } from '@/lib/kuzmich/core';
import { detectEmergency, withSosBlock } from '@/lib/safety/sos-detector';
import { stripTags } from '@/lib/html/text';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { parseInterestsFromText, findRoutesByInterests } from '@/lib/planner/interests';
import {
  postRouteToChannel,
  postOperatorToChannel,
  postSezonToChannel,
  postFriendToChannel,
} from '@/lib/notifications/telegram-channel';
import { PlatformAgent } from '@/lib/agents/platform-agent';
import { classifyIntentByKeywords } from '@/lib/agents/intent-classifier';
import { verifyConnectToken } from '@/lib/telegram/connect-token';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';
import { partnerLinkArgFromText, partnerTokenFromStart, verifyPartnerLinkToken } from '@/lib/partners/channel-link';
import { PARTNER_EMAIL_BIND_CLOSED } from '@/lib/kuzmich/operator-chat';
import { bindPartnerChannel, badLinkReplyText, boundMenuRow, channelBoundText } from '@/lib/partners/bind-channel';
import { bindCodeMissedText, bindCodeRenewUrl, consumeBindCode, normalizeBindCode } from '@/lib/partners/bind-code';
import { parseRentalCabinetPress, telegramCabinetMarkup, type CabinetButton } from '@/lib/rental/cabinet-bar';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { tryRentalCabinetTelegramMessage, tryRentalCabinetTelegramPress } from '@/lib/rental/cabinet-telegram';
import { type MenuButton } from '@/lib/roles/chat-menu';
import { adminMenu, parseRoleMenuPress } from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import { tryRoleMenuTelegramMessage, tryRoleMenuTelegramPress } from '@/lib/roles/role-telegram';
import { operatorReplyMarkup } from '@/lib/telegram/operator-desk';
import { isOperatorDeskPayload, operatorDeskPress } from '@/lib/telegram/operator-desk-press';
import { isOwnerPressPayload } from '@/lib/bookings/chat-owner-press';
import { roleChatCommands, setOperatorChatCommands, setRoleChatCommands } from '@/lib/telegram/role-commands';
import { handleMemberStart } from '@/lib/operators/member-channel';
import { resolveTelegramBotUsername } from '@/lib/telegram/bot-username';
import { statusTokenFromStart, touristBindReplyText } from '@/lib/seat-requests/core';
import { bindTouristChat } from '@/lib/seat-requests/service';
import { sendWelcomeMessage } from '@/lib/telegram/welcome';
import { createTicket, getUserOpenTickets, addTicketMessage } from '@/lib/support/ticket.service';
import { categorizeSupport, CATEGORY_LABELS, RESIDENT_INTRO } from '@/lib/support/categorize';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { groupMonitor } from '@/lib/telegram/group-monitor';
import { createLead } from '@/lib/leads/create';
import { isTechnicalHost } from '@/lib/config';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { applyLeadStatus, LEAD_STATUS_ACTIONS } from '@/lib/leads/status-action';
import {
  handleTelegramAdminTurn,
  TELEGRAM_ADMIN_DENY,
  TELEGRAM_ADMIN_UNCHECKED,
  telegramAdminCallbackGate,
} from '@/lib/telegram/admin-chat';

export const dynamic = 'force-dynamic';

/** Роли, чей Telegram пишется и в карточку партнёра; transfer_operator — устаревшее имя перевозчика. */
const PARTNER_CHAT_ROLES: ReadonlySet<string> = new Set([...PARTNER_ROLES, 'transfer_operator']);

// Пользователи в процессе оформления заявки через /start lead
const pendingLeadFlow = new Map<string, { firstName: string; startedAt: number }>();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of pendingLeadFlow) {
    if (v.startedAt < cutoff) pendingLeadFlow.delete(k);
  }
}, 5 * 60 * 1000);

const KUZMICH_TG_SUFFIX =
  '\n\nРЕЖИМ: Telegram-чат. Ответ 70-120 слов. HTML-теги: <b>жирный</b>, <i>курсив</i>. Без markdown-звёздочек.';

// ── Zod-схемы ─────────────────────────────────────────────────────────────────

const TelegramUserSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
});

const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number().optional(),
    from: TelegramUserSchema.optional(),
    chat: TelegramChatSchema.optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string(),
    from: TelegramUserSchema,
    message: z.object({ chat: TelegramChatSchema.optional() }).optional(),
    data: z.string().optional(),
  }).optional(),
});

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { chat: { id: number; type?: string } };
    data?: string;
  };
}

interface RouteRow { id: string; title: string; category: string; description: string | null }
/** Список заявок для Telegram: ПД не читаются — их здесь не показывают. */
interface LeadRow { id: string; route_title: string | null; created_at: string; status: string }
interface StatsRow {
  bookings_today: string; bookings_30d: string;
  leads_today: string;    leads_30d: string;
  total_users: string;    active_tours: string;
  views_today: string;    views_30d: string;
}
interface TopPageRow { path: string; cnt: string; }

// ── Утилиты ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isAdmin(userId: number): boolean {
  const adminId = process.env.TELEGRAM_CHAT_ID;
  return !!adminId && adminId === String(userId);
}

async function sendHTML(chatId: string, text: string): Promise<void> {
  await telegramService.sendMessage({ chatId, text, parseMode: 'HTML' });
}

/** Личка туриста: та же HTML-отправка и постоянная клавиатура. Кабинету её не ставим. */
async function sendTourist(chatId: string, text: string): Promise<void> {
  await telegramService.sendMessage({
    chatId,
    text: repairTelegramHtml(text),
    parseMode: 'HTML',
    replyMarkup: touristReplyMarkup(),
  });
}

/**
 * Ответ кабинета проката: та же строка кнопок под текстом.
 *
 * Свободная реплика кабинета — ответ модели, и в нём бывает голый `<`.
 * Прежняя отправка слала текст как есть и не смотрела на ответ Bot API:
 * 400 «can't parse entities» глотался, прокатчик не получал ничего.
 * Тот же разбор, что у ответа туриста: сначала HTML, который Bot API
 * примет; не принял — второй раз без тегов. Кнопки остаются на обеих
 * попытках. Не принят и второй — отказ в лог (§4.0).
 */
async function sendHtmlKeyboard(
  chatId: string,
  text: string,
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  logLabel: string,
): Promise<void> {
  const clean = sanitizeForTelegram(text);
  const html = await telegramService.sendMessage({
    chatId, text: repairTelegramHtml(clean), parseMode: 'HTML', replyMarkup,
  });
  if (html.success) return;
  const plain = await telegramService.sendMessage({
    chatId, text: repairTelegramHtml(esc(stripTags(clean))), parseMode: 'HTML', replyMarkup,
  });
  if (!plain.success) {
    console.error(`[telegram/webhook] ${logLabel} не доставлен`, { html: html.error, plain: plain.error });
  }
}

async function sendRentalCabinet(chatId: string, text: string, buttons: CabinetButton[][] = []): Promise<void> {
  await sendHtmlKeyboard(chatId, text, telegramCabinetMarkup(buttons), 'ответ кабинета');
}

function roleKeyboard(buttons: MenuButton[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.payload }))) };
}

async function sendRoleRows(chatId: string, text: string, buttons: MenuButton[][]): Promise<void> {
  await sendHtmlKeyboard(chatId, text, roleKeyboard(buttons), 'ответ меню роли');
}

/** Постоянные кнопки телефона. Пустой inline их не заменяет. */
async function sendOperatorKeyboard(chatId: string, text: string): Promise<void> {
  const clean = sanitizeForTelegram(text);
  const html = await telegramService.sendMessage({
    chatId,
    text: repairTelegramHtml(clean),
    parseMode: 'HTML',
    replyMarkup: operatorReplyMarkup(),
  });
  if (html.success) return;
  const plain = await telegramService.sendMessage({
    chatId,
    text: repairTelegramHtml(esc(stripTags(clean))),
    parseMode: 'HTML',
    replyMarkup: operatorReplyMarkup(),
  });
  if (!plain.success) {
    console.error('[telegram/webhook] клавиатура оператора не доставлена', { html: html.error, plain: plain.error });
  }
}

async function sendRenewCode(chatId: string, text: string): Promise<void> {
  await telegramService.sendMessage({
    chatId,
    text: repairTelegramHtml(sanitizeForTelegram(text)),
    parseMode: 'HTML',
    replyMarkup: { inline_keyboard: [[{ text: 'Получить новый', url: bindCodeRenewUrl() }]] },
  });
}

async function replyOperatorBound(
  chatId: string,
  numericChatId: number,
  bound: Awaited<ReturnType<typeof bindPartnerChannel>>,
): Promise<void> {
  const text = channelBoundText('telegram', bound);
  if (bound.ok && isRentalPilotSlug(bound.slug)) {
    await sendRentalCabinet(chatId, text);
    return;
  }
  if (bound.ok && bound.category === 'operator') {
    await sendOperatorKeyboard(chatId, text);
    void setOperatorChatCommands(numericChatId);
    return;
  }
  // Гид — его строка меню под ответом и те же команды чата. Нет строки
  // (кабинет в этом чате у другой карточки) — без кнопок: они не сработали бы.
  const row = boundMenuRow(bound);
  if (row) {
    await sendRoleRows(chatId, text, [row]);
    void setRoleChatCommands(numericChatId, roleChatCommands(row));
    return;
  }
  await sendHTML(chatId, text);
}

// ── Поиск пользователя по Telegram ID ────────────────────────────────────────

interface LinkedUser {
  id: string;
  name: string;
  role: string;
  email: string;
}

async function getUserByTelegramId(telegramId: number): Promise<LinkedUser | null> {
  try {
    const res = await query<LinkedUser>(
      `SELECT id, name, role, email FROM users WHERE telegram_id = $1 LIMIT 1`,
      [telegramId]
    );
    return res.rows[0] ?? null;
  } catch { return null; }
}

// ── Определение обращений в поддержку ─────────────────────────────────────────

const SUPPORT_TRIGGERS = [
  'помогите', 'помощь', 'поддержка', 'жалоба', 'обращение',
  'проблема', 'не работает', 'ошибка', 'баг', 'сломалось',
  'оператор не отвечает', 'деньги не пришли', 'возврат', 'верните',
  'не подтвердил', 'обманул', 'неправильно', 'недоволен', 'претензия',
  'не могу войти', 'заблокировали', 'что делать', 'куда обратиться',
];

function isSupportRequest(text: string): boolean {
  // Точные подписи кнопок кабинета тикет не создают. «Помощь» — справка;
  // обращение пишет только кнопка «Написать в поддержку».
  const exact = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
  if (exact === 'помощь' || exact === 'справка') return false;
  const lower = text.toLowerCase();
  return SUPPORT_TRIGGERS.some(trigger => lower.includes(trigger));
}

// ── Кузьмич: общий мозг (аудит 15.10, TG-BRAIN) ──────────────────────────────
//
// До 15.10 этот вебхук — живой вход Telegram — отвечал туристу своей копией
// Кузьмича: одиночный вызов модели с сырым текстом и историей из
// chat_sessions. Без инструментов (обстановка и безопасность места — только
// из них), без серверного блока 112 на «мы заблудились», без чистки
// телефонов и почт перед зарубежной моделью и без сторожей утверждений о
// безопасности и доставке. У веба, MAX и второго входа /api/telegram/kuzmich
// всё это было через lib/kuzmich/core — и политика конфиденциальности
// обещала чистку для Telegram тоже. Теперь все три места, где вебхук давал
// слово Кузьмичу (личка, упоминание в группе, /sezon), идут в aiChat.
//
// aiChat, а не processMessage: processMessage добавляет к нему бронь в чате —
// спрашивает имя и телефон и повторяет их в подтверждении. Политика
// конфиденциальности (разд. 5) обещает, что Telegram несёт только служебные
// сообщения без ПД, и по той же причине контроль выхода здесь не ставится
// (lib/kuzmich/watch-flow). Включить бронь в чате Telegram — решение
// владельца, а не побочный эффект этой правки. Контроль выхода и
// slash-команды вебхук и так разбирает раньше.

/**
 * История Кузьмича в Telegram — tg_conversations под режимом 'tourist', как у
 * второго входа: chat_id тот же (бот один). Прежняя история вебхука
 * (chat_sessions, 'tg_<chatId>') перенесена туда миграцией, разговор не
 * обрывается на выкате.
 */
const KUZMICH_TG_MODE = 'tourist';

/**
 * Ответ Кузьмича в чат. Тот же разбор разметки, что у второго входа
 * (lib/telegram/kuzmich-format): модель пишет то звёздочками, то эмодзи.
 * Голый `<` и длина сверх 4096 — repairTelegramHtml: прежний sendHTML слал
 * ответ модели как есть, и Bot API на такой ответ отвечал 400 — турист не
 * получал ничего, а отказ не попадал никуда. Не принят HTML — второй раз
 * простым текстом; не принят и он — отказ в лог (§4.0).
 */
async function sendKuzmichReply(
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> } | ReturnType<typeof touristReplyMarkup>,
): Promise<void> {
  const clean = emphasizeTripDays(sanitizeForTelegram(text.replace(/TourHab/g, 'Ведар')));
  const html = await telegramService.sendMessage({
    chatId: String(chatId), text: repairTelegramHtml(clean), parseMode: 'HTML', replyMarkup,
  });
  if (html.success) return;
  const plain = await telegramService.sendMessage({
    chatId: String(chatId), text: repairTelegramHtml(esc(stripTags(clean))), parseMode: 'HTML', replyMarkup,
  });
  if (!plain.success) {
    console.error('[telegram/webhook] ответ Кузьмича не доставлен', { html: html.error, plain: plain.error });
  }
}

/** Мозг не ответил вовсе (исключение) — человек узнаёт об этом, а не ждёт. */
const KUZMICH_FAILED_TEXT = 'Не получилось ответить — сбой на нашей стороне. Повторите через минуту. В беде — 112.';

/**
 * Свободный текст → aiChat (lib/kuzmich/core): инструменты, граница ПД
 * (redactUserTurns в цикле и на запасном пути), сторожа утверждений, блок 112
 * и замер ответа (surface telegram — его пишет aiChat, второго здесь нет).
 *
 * Блок 112 ставится и здесь, поверх core: aiChat ставит его только тому
 * ответу, который собрал сам. Если мозг упал исключением, человек получает
 * KUZMICH_FAILED_TEXT — и на «мы заблудились» он обязан нести блок тоже.
 * Второй раз блок не встаёт: withSosBlock видит в ответе 112 и МЧС.
 */
async function answerByKuzmich(opts: {
  chatId: number;
  text: string;
  userId: number | null;
  /** Личка туриста: клавиатура. Кабинет и группа — без неё. */
  tourist?: boolean;
}): Promise<void> {
  // Один ответ на сообщение. Список туров, пауза проката и цена прошлого
  // варианта собираются в aiChat (resolveCommercialTurn) и сюда не дописываются
  // второй раз: раньше пауза ставилась и текстом, и просьбой модели сказать то же.
  const reply: ReplyFn = (id, answer) => {
    // Текст одного сообщения: повтор паузы и цена без ссылки сюда не доходят.
    // Кабинет проката идёт другим отправителем и эту функцию не зовёт.
    const shown = telegramOfferLinks(collapseRepeatedReply(answer));
    const body = withSosBlock(shown, opts.text).text;
    const offer = requestButton(body);
    // Кнопка ведёт на форму, которая создаёт заявку. Клавиатуру туриста
    // на этом сообщении не заменяем второй ссылкой: пауза проката кнопки не получает.
    const markup = offer
      ? { inline_keyboard: [[{ text: offer.text, url: offer.url }]] }
      : (opts.tourist ? touristReplyMarkup() : undefined);
    return sendKuzmichReply(id, body, markup);
  };
  try {
    await aiChat({
      chatId: opts.chatId, text: opts.text, mode: KUZMICH_TG_MODE, reply,
      // Имя не пишется: историю читают по роли и тексту, имя в ней не
      // читает никто — хранить его незачем (минимизация ПД, 152-ФЗ).
      userId: opts.userId, userName: null, platform: 'tg',
    });
  } catch (err) {
    logSwallowedFailure('telegram/webhook', 'ответ Кузьмича', err);
    await reply(opts.chatId, KUZMICH_FAILED_TEXT);
  }
}

async function answerTouristButton(chatId: string, button: TouristButton): Promise<void> {
  if (button === 'Погода') {
    await sendTourist(chatId, await getWeather());
    return;
  }
  if (button === 'Операторы') {
    await sendTourist(chatId, await touristOperatorsList());
    return;
  }
  if (button === 'Аренда авто') {
    await sendTourist(chatId, touristRentalText());
    return;
  }
  if (button === 'Задать вопрос') {
    await sendTourist(chatId, TOURIST_ASK_TEXT);
    return;
  }
  const facts = catalogFacts('подобрать тур', await loadShowcaseTours('подобрать тур'));
  if (facts.html) await sendTourist(chatId, facts.html);
  else await sendTourist(chatId, 'В каталоге Ведара сейчас нет живого тура. Название и цену я не выдумываю.');
  if (facts.inline) {
    await telegramService.sendMessage({
      chatId,
      text: 'Карточки — по кнопкам. Цена на кнопке из каталога.',
      parseMode: 'HTML',
      replyMarkup: facts.inline,
    });
  }
}

// ── Случайный маршрут ─────────────────────────────────────────────────────────

async function getRandomRoute(): Promise<RouteRow | null> {
  try {
    const res = await query<RouteRow>(
      `SELECT id::text, title, category, description FROM agent_route_knowledge
       WHERE is_visible = TRUE ORDER BY RANDOM() LIMIT 1`
    );
    return res.rows[0] ?? null;
  } catch { return null; }
}

// ── Погода (wttr.in, без API-ключа) ──────────────────────────────────────────

interface WttrCurrent {
  temp_C: string;
  FeelsLikeC: string;
  humidity: string;
  windspeedKmph: string;
  weatherDesc: Array<{ value: string }>;
  lang_ru?: Array<{ value: string }>;
}

async function getWeather(): Promise<string> {
  try {
    const res = await fetch(
      'https://wttr.in/Petropavlovsk-Kamchatsky?format=j1&lang=ru',
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error('wttr.in unavailable');
    const data = await res.json() as { current_condition: WttrCurrent[] };
    const c = data.current_condition[0];
    const desc = c.lang_ru?.[0]?.value ?? c.weatherDesc[0]?.value ?? '';
    const t = parseInt(c.temp_C);
    const f = parseInt(c.FeelsLikeC);
    const sign = (n: number) => n > 0 ? `+${n}` : String(n);
    return [
      '🌤 <b>Петропавловск-Камчатский</b>',
      '',
      `🌡 <b>${sign(t)}°C</b>  (ощущается ${sign(f)}°C)`,
      desc ? `☁️ ${esc(desc)}` : '',
      `💨 Ветер: ${c.windspeedKmph} км/ч`,
      `💧 Влажность: ${c.humidity}%`,
    ].filter(Boolean).join('\n');
  } catch {
    return 'Погода временно недоступна. Зайди позже.';
  }
}

// ── Admin: статистика ─────────────────────────────────────────────────────────

async function getStats(): Promise<string> {
  try {
    const [statsRes, topRes] = await Promise.all([
      query<StatsRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM operator_bookings WHERE created_at >= CURRENT_DATE)             AS bookings_today,
          (SELECT COUNT(*)::text FROM operator_bookings WHERE created_at >= NOW()-INTERVAL '30 days') AS bookings_30d,
          (SELECT COUNT(*)::text FROM leads    WHERE created_at >= CURRENT_DATE)             AS leads_today,
          (SELECT COUNT(*)::text FROM leads    WHERE created_at >= NOW()-INTERVAL '30 days') AS leads_30d,
          (SELECT COUNT(*)::text FROM users)                                                 AS total_users,
          (SELECT COUNT(*)::text FROM operator_tours WHERE is_active = TRUE)                          AS active_tours,
          (SELECT COUNT(*)::text FROM page_views WHERE created_at >= CURRENT_DATE)           AS views_today,
          (SELECT COUNT(*)::text FROM page_views WHERE created_at >= NOW()-INTERVAL '30 days') AS views_30d
      `),
      query<TopPageRow>(`
        SELECT path, COUNT(*)::text AS cnt
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY path ORDER BY cnt::int DESC LIMIT 5
      `),
    ]);
    const s = statsRes.rows[0];
    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const lines = [
      `<b>Статистика TourHab</b>  <i>${today}</i>`,
      '',
      `👁 Просмотры сегодня: <b>${s.views_today}</b>   за 30 дней: <b>${s.views_30d}</b>`,
      `📦 Брони сегодня: <b>${s.bookings_today}</b>   за 30 дней: <b>${s.bookings_30d}</b>`,
      `📋 Лиды сегодня:  <b>${s.leads_today}</b>   за 30 дней: <b>${s.leads_30d}</b>`,
      '',
      `👥 Пользователей: <b>${s.total_users}</b>`,
      `🗺 Активных туров: <b>${s.active_tours}</b>`,
    ];
    if (topRes.rows.length) {
      lines.push('', '<b>Топ страниц за 7 дней:</b>');
      topRes.rows.forEach((r, i) => {
        lines.push(`${i + 1}. <code>${esc(r.path)}</code> — ${r.cnt}`);
      });
    }
    return lines.join('\n');
  } catch {
    return 'Не удалось загрузить статистику.';
  }
}

// ── Admin: последние лиды ─────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  new: 'Новый',
  contacted: 'Позвонили',
  qualified: 'Квалифицирован',
  converted: 'Сделка',
  lost: 'Отказ',
};

async function getLastLeads(): Promise<string> {
  try {
    const res = await query<LeadRow>(
      `SELECT id::text, route_title, created_at::text, status
       FROM leads ORDER BY created_at DESC LIMIT 5`
    );
    if (!res.rows.length) return 'Заявок пока нет.';
    // Имя и телефон в Telegram не показываются (решение владельца 23.08):
    // ПД туриста идут только в MAX и в кабинет. Здесь — очередь и её состояние.
    const lines = ['<b>Последние 5 заявок:</b>', ''];
    res.rows.forEach((l, i) => {
      const date = new Date(l.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const statusLabel = STATUS_LABEL[l.status] ?? l.status;
      lines.push(`${i + 1}. <code>${l.id}</code>  [${statusLabel}]`);
      if (l.route_title) lines.push(`   ${esc(l.route_title)}`);
      lines.push(`   <i>${date}</i>`);
    });
    lines.push('', 'Имя и телефон — в MAX и в кабинете.');
    return lines.join('\n');
  } catch {
    return 'Не удалось загрузить лиды.';
  }
}

// ── Lead creation from bot ───────────────────────────────────────────────────

interface ExtractedInterests {
  interests?: string[];
  dateFrom?: string;
  dateTo?: string;
}

function extractLastInterestsFromHistory(history: ChatMessage[]): ExtractedInterests {
  for (let i = history.length - 1; i >= Math.max(0, history.length - 10); i--) {
    if (history[i]?.role === 'user') {
      const parsed = parseInterestsFromText(history[i].content);
      if (parsed.interests.length > 0) return parsed;
    }
  }
  return {};
}

interface OperatorRow2 {
  name: string;
  slug: string;
  /** Адрес оператора в MAX — туда идут ПД. NULL: ПД ему не уходят. */
  max_chat_id: string | null;
  telegram_chat_id: string | null;
}

async function createLeadFromBot(
  chatId: string,
  phoneText: string,
  interests: ExtractedInterests
): Promise<void> {
  try {
    const phone = phoneText;
    const interestList = interests.interests ?? [];
    const comment = interestList.length > 0
      ? `Интересы: ${interestList.join(', ')}${interests.dateFrom ? ` · Даты: ${interests.dateFrom} - ${interests.dateTo}` : ''}`
      : 'Заявка с Telegram бота';

    const leadId = await createLead({
      name: 'Турист',
      phone,
      comment,
      source_url: 'https://t.me/kuzmichai_bot',
      source_data: {
        source: 'telegram_bot',
        interests: interestList,
        date_from: interests.dateFrom,
        date_to: interests.dateTo,
        chat_id: chatId,
        timestamp: new Date().toISOString(),
      },
      telegram_chat_id: chatId,
    });

    // ── 1. Автоответ туристу ───────────────────────────────────────────────
    const routes = interestList.length > 0
      ? await findRoutesByInterests(interestList, 2)
      : [];

    const touristLines = [
      '✅ <b>Заявка принята!</b>',
      '',
      'Оператор свяжется с вами в течение <b>1–2 часов</b> по номеру',
      `<b>${esc(phone)}</b>`,
    ];

    if (routes.length > 0) {
      touristLines.push('', '<b>Пока посмотрите подходящие маршруты:</b>');
      routes.forEach((r, i) => {
        const price = r.priceFrom ? ` — от ${Math.round(r.priceFrom / 1000)}к₽` : '';
        touristLines.push(`${i + 1}. <a href="https://vedarai.ru/routes/${r.id}">${esc(r.title)}</a>${price}`);
      });
    }

    touristLines.push('', 'Если вопросы — пишите прямо здесь, помогу 🙌');

    await telegramService.sendMessage({
      chatId,
      text: touristLines.join('\n'),
      parseMode: 'HTML',
    }).catch(() => {});

    // ── 2. Уведомление нужному оператору ──────────────────────────────────
    if (interestList.length > 0) {
      const opRes = await pool.query<OperatorRow2>(
        `SELECT p.name, p.slug, p.max_chat_id::text AS max_chat_id,
                p.contacts->>'telegram_chat_id' AS telegram_chat_id
         FROM partners p
         JOIN operator_tours ot ON ot.operator_id = p.id
         JOIN agent_route_knowledge ark ON ark.id = ot.route_id
         WHERE ark.activity_type = ANY($1)
           AND p.is_public = TRUE
           AND (p.max_chat_id IS NOT NULL OR (p.contacts->>'telegram_chat_id') IS NOT NULL)
         GROUP BY p.name, p.slug, p.max_chat_id, p.contacts->>'telegram_chat_id'
         LIMIT 3`,
        [interestList]
      );

      const facts = [
        `<b>Интересы:</b> ${interestList.join(', ')}`,
        interests.dateFrom ? `<b>Даты:</b> ${interests.dateFrom} — ${interests.dateTo}` : '',
      ].filter(s => s !== '');

      for (const op of opRes.rows) {
        // Телефон туриста — ПД: идёт в MAX оператора. Если MAX у него не
        // привязан, в Telegram уходит заглушка без телефона.
        const res = await sendPdAlert({
          text: [
            '<b>Горячий лид</b>',
            '',
            `<b>Телефон:</b> ${esc(phone)}`,
            ...facts,
            '',
            'Свяжитесь в течение 1-2 часов — турист ждёт.',
          ].join('\n'),
          stub: [
            '<b>Горячий лид</b>',
            '',
            ...facts,
            '',
            'Телефон — в MAX и в кабинете. Свяжитесь в течение 1-2 часов.',
          ].join('\n'),
          buttons: [{ text: 'Открыть в CRM', url: 'https://vedarai.ru/hub/operator/bookings' }],
          to: { maxChatId: op.max_chat_id, telegramChatId: op.telegram_chat_id },
        });
        if (!res.delivered) {
          console.error(`[telegram/webhook] горячий лид ${op.slug}: ПД не доставлены (${res.channel}) — ${res.reason}`);
        }
      }
    }

    // Уведомление админу отправлено автоматически через createLead()

  } catch (err) {
  }
}

// ── Создание лида из Telegram /start lead flow ────────────────────────────────
async function createLeadFromTelegramFlow(
  chatId: string,
  firstName: string,
  telegramUserId: number,
  telegramUsername: string | null,
  message: string,
): Promise<void> {
  try {
    const leadId = await createLead({
      name: firstName,
      phone: telegramUsername ? `@${telegramUsername}` : `tg:${telegramUserId}`,
      comment: message,
      source_url: 'https://t.me/kuzmichai_bot',
      source_data: {
        source: 'telegram_lead_flow',
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername,
        chat_id: chatId,
      },
      telegram_chat_id: chatId,
    });
    if (!leadId) return;

    // AI обработка — после завершения отвечаем туристу в ТГ
    try {
      const proposal = await leadProcessor.process(leadId);
      const lines = [
        `<b>${esc(proposal.headline)}</b>`,
        '',
        proposal.intent.activity_types.length > 0
          ? `Направление: ${proposal.intent.activity_types.join(', ')}`
          : '',
        (proposal.intent.group_size ?? 0) > 1 ? `Группа: ${proposal.intent.group_size} чел.` : '',
        proposal.intent.budget_rub ? `Бюджет: ~${(proposal.intent.budget_rub / 1000).toFixed(0)}к руб` : '',
        proposal.intent.desired_dates ? `Даты: ${esc(proposal.intent.desired_dates)}` : '',
        '',
        proposal.primary_tour
          ? `<b>Рекомендую:</b> ${esc(proposal.primary_tour.title)} — от ${proposal.primary_tour.price.toLocaleString('ru-RU')} руб/чел`
          : '',
        '',
        `<i>${esc(proposal.intent.qualification_notes)}</i>`,
        '',
        'Менеджер свяжется с вами в ближайшее время для уточнения деталей.',
      ].filter(Boolean).join('\n');

      await sendHTML(chatId, lines);
    } catch {
      // AI не отработал — уже отправили "принято", достаточно
    }
  } catch {
    // Тихая ошибка
  }
}

// ── Основной обработчик ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Сверка через общий lib/telegram/webhook-secret. Здесь стояла своя копия с
  // обычным `!==`: то же правило в третьем месте и без защиты от тайминга.
  // Копии правил в этом репозитории расходятся — за один сегодняшний день это
  // случилось со списком глаголов, со стилем линии и с типом ключа.
  const verdict = verifyWebhookSecret(
    request.headers.get('X-Telegram-Bot-Api-Secret-Token'),
    process.env.TELEGRAM_WEBHOOK_SECRET,
  );
  if (verdict === 'forbidden') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  // Без секрета — отказ, а не работа «без проверки» (аудит 15.10, P3-03): ниже
  // админ-ветка верит from.id из тела, и без секрета её открывал любой, кто
  // знает числовой id владельца. Почему это не глушит бота — в шапке
  // refuseUnconfiguredWebhook.
  if (verdict === 'not_configured') {
    return refuseUnconfiguredWebhook('telegram/webhook', 'TELEGRAM_WEBHOOK_SECRET');
  }

  let update: TelegramUpdate;
  try {
    const json = await request.json();
    const parsed = TelegramUpdateSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
    update = parsed.data as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  // Фото с подписью отвечается по подписи (проверка качества 24.10): схема
  // подписи не знала, и «помогите, мы заблудились» под снимком оставалось
  // без ответа вовсе. Сам снимок здесь не разбирается — только его подпись.
  // Подпись-команда («/post …» под снимком) командой не становится.
  if (update.message && !update.message.text && update.message.caption?.trim()
    && !update.message.caption.trim().startsWith('/')) {
    update.message.text = update.message.caption;
  }

  // Повтор того же апдейта (Bot API не дождался ответа) — не отвечать дважды.
  if (isRepeatedTelegramUpdate(update.update_id)) {
    return NextResponse.json({ ok: true });
  }

  // 200 сразу, ход — в очереди чата. Иначе Bot API присылает следующий
  // апдейт, пока модель ещё отвечает на предыдущий.
  const work = enqueueTelegramChat(telegramChatKey(update), async () => {
    try {
      await deliverTelegramUpdate(update);
    } catch (err) {
      console.error('[telegram/webhook] апдейт не обработан', err instanceof Error ? err.message : err);
    }
  });
  if (webhookAwaitsHandler()) await work;
  return NextResponse.json({ ok: true });
}

/**
 * Голос, геопозиция, стикер или снимок без подписи в личке: разобрать их
 * здесь нечем, но и молчать нельзя — в них может быть беда (проверка
 * качества 24.10: голосовое SOS не получало никакого ответа).
 */
const NON_TEXT_REPLY =
  'Здесь я читаю только текст — напишите словами. В беде — звоните 112: '
  + 'работает без SIM-карты и баланса. Кнопка SOS с координатами: vedarai.ru/sos';

async function deliverTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message && !update.message.text?.trim() && update.message.chat?.type === 'private') {
    await sendHTML(String(update.message.chat.id), NON_TEXT_REPLY);
    return;
  }

  // ── Текстовые сообщения ───────────────────────────────────────────────────
  if (update.message?.text && update.message.chat) {
    const chatId  = String(update.message.chat.id);
    const fromId  = update.message.from?.id ?? 0;
    const text    = update.message.text.trim();
    const admin   = isAdmin(fromId);

    // ── Группы и супергруппы: тихий мониторинг ─────────────────────────────
    const chatType = (update.message.chat as { type?: string }).type ?? 'private';
    if (chatType === 'group' || chatType === 'supergroup') {
      const groupTitle = (update.message.chat as { title?: string }).title ?? 'Группа';
      const fromName   = update.message.from?.first_name ?? 'Участник';

      // Собираем разведку асинхронно — не блокируем ответ Telegram
      groupMonitor.processMessage(chatId, groupTitle, fromName, text);

      // Отвечаем только если прямо @упомянули бота
      const botUser = (await resolveTelegramBotUsername()).name;
      const mentioned = text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
      if (mentioned) {
        const cleanQ = text.replace(new RegExp(`@${botUser}`, 'gi'), '').trim();
        // Тот же мозг, что в личке (TG-BRAIN): «@бот мы заблудились» в
        // группе — такое же сообщение о беде. aiChat, а не processMessage:
        // бронь в чате спросила бы имя и телефон на виду у всей группы.
        await answerByKuzmich({
          chatId: update.message.chat.id,
          text: cleanQ || 'Привет! Чем помочь?',
          userId: update.message.from?.id ?? null,
        });
      }

      return;
    }

    // Администратор по привязке из админки (adt_, миграция 1330). Личный чат:
    // группы уже вышли выше и таблицу привязки не спрашивают. Чужой /start
    // (op_, link_, lead) ход не забирает. Владелец консоли TELEGRAM_CHAT_ID
    // остаётся на ней и с привязкой: /leads, /post, /digest у кабинета чтения
    // нет, и после «Старт» по adt_ они отвечали «Не понял команду» (проверка
    // каналов 25.10). Сама ссылка adt_ доходит и до него — так её гасят.
    if (chatType === 'private' && fromId > 0 && (!admin || /^\/start\s+\S/.test(text))) {
      const turn = await handleTelegramAdminTurn({
        text,
        fromId,
        nowMs: Date.now(),
        yieldToPartner: (t) => adminChatYieldsToPartner('telegram', update.message!.chat.id, t),
        reply: async (body, buttons) => {
          if (buttons?.length) await sendRoleRows(chatId, body, buttons);
          else await sendHTML(chatId, body);
        },
      });
      if (turn === 'handled') return;
      if (turn === 'tourist') {
        await answerByKuzmich({
          chatId: update.message.chat.id,
          text,
          userId: update.message.from?.id ?? null,
          tourist: true,
        });
        return;
      }
    }

    // /start [link_{token}] — привязка аккаунта или приветствие.
    // Голое «op_…» в личке — тот же код, что аргумент /start: клиент мог
    // отдать его обычным сообщением. В группе (уже вышла выше) чат не пишем.
    const typedLink = chatType === 'private' ? partnerLinkArgFromText(text) : null;
    if (text.startsWith('/start') || typedLink !== null) {
      const arg = typedLink ?? text.slice('/start'.length).trim();
      // Личный чат: кто открыл ссылку — для входа на сайт через Telegram (1336).
      // В личном чате id чата равен id человека; иначе владелец не пишется.
      const linkOpener = chatType === 'private' && fromId > 0 && update.message.chat.id === fromId ? fromId : null;

      // /start ABC123 — код из кабинета туроператора. Пишет чат в карточку
      // партнёра, не в users.telegram_id: администратор в «Войти как»
      // не получает командный центр.
      if (normalizeBindCode(arg)) {
        const consumed = await consumeBindCode(arg, 'telegram', update.message.chat.id);
        if (!consumed.ok) {
          console.error(`[telegram-webhook] код привязки не подошёл: ${consumed.reason}`);
          const missed = consumed.reason === 'db_error'
            ? 'Не удалось проверить код — база не ответила. Попробуйте через несколько минут.'
            : bindCodeMissedText();
          await sendRenewCode(chatId, missed);
          return;
        }
        const byCode = await bindPartnerChannel(consumed.partnerId, 'telegram', update.message.chat.id, linkOpener);
        if (!byCode.ok) {
          console.error(`[telegram-webhook] код принят, карточка не записана: ${byCode.reason}`);
          await sendRenewCode(chatId, 'Не удалось сохранить привязку. Нажмите «Получить новый».');
          return;
        }
        await replyOperatorBound(chatId, update.message.chat.id, byCode);
        return;
      }

      // /start op_{token} — оператор подключает этот чат к получению заявок
      // (ссылку выдал администратор, lib/partners/channel-link). Пишется в
      // карточку ПАРТНЁРА, а не человека: у импортированных операторов
      // аккаунта на платформе нет.
      const partnerToken = partnerTokenFromStart(arg);
      if (partnerToken !== null) {
        const check = verifyPartnerLinkToken(partnerToken);
        if (!check.ok) {
          console.error(`[telegram-webhook] ссылка привязки оператора отклонена: ${check.reason}`);
          await sendHTML(chatId, badLinkReplyText(check.reason));
          return;
        }
        const bound = await bindPartnerChannel(check.partnerId, 'telegram', update.message.chat.id, linkOpener);
        await replyOperatorBound(chatId, update.message.chat.id, bound);
        return;
      }

      // /start om_{token} — менеджер команды оператора подключает этот чат к
      // уведомлениям кабинета (CRM 2г-4). Пишется в ЕГО строку команды, а не в
      // карточку партнёра: чат кабинета остаётся за владельцем.
      if (await handleMemberStart(arg, 'telegram', update.message.chat.id, (t) => sendHTML(chatId, t))) {
        return;
      }

      // /start sr_{ключ статуса} — турист хочет получить ответ оператора на
      // запрос мест сюда (lib/seat-requests). Ответ уже есть — уходит сразу.
      const seatToken = statusTokenFromStart(arg);
      if (seatToken !== null) {
        const bound = await bindTouristChat(seatToken, 'telegram', update.message.chat.id);
        await sendHTML(chatId, touristBindReplyText(bound));
        return;
      }

      // /start link_{token} — привязка email-аккаунта к Telegram
      if (arg.startsWith('link_')) {
        const token = arg.slice('link_'.length);
        const userId = verifyConnectToken(token);

        if (!userId) {
          await sendHTML(chatId, [
            '<b>Ссылка недействительна или истекла.</b>',
            '',
            'Получи новую в личном кабинете: Профиль → Подключить Telegram.',
          ].join('\n'));
          return;
        }

        // Связываем telegram_id с аккаунтом
        const linkRes = await query<{ name: string; role: string }>(
          `UPDATE users SET telegram_id = $1, telegram_username = $2
           WHERE id = $3 AND (telegram_id IS NULL OR telegram_id = $1)
           RETURNING name, role`,
          [update.message.from.id, update.message.from.username ?? null, userId]
        );

        if (!linkRes.rows[0]) {
          await sendHTML(chatId, 'Аккаунт уже привязан к другому Telegram. Обратись в поддержку.');
          return;
        }

        const { name, role } = linkRes.rows[0];

        // Партнёр любой из шести ролей — адрес и в карточку партнёра. До
        // 09.10 только оператор и гид: у жилья, проката, перевозчика и агента
        // чат ложился лишь в users.telegram_id, и уведомления, читающие
        // колонку партнёра (бронь жилья, аренда), его не видели, хотя
        // reachForPartner считал партнёра подключённым (CRM 1в-3).
        if (PARTNER_CHAT_ROLES.has(role)) {
          await query(
            `UPDATE partners SET telegram_chat_id = $1 WHERE user_id = $2`,
            [update.message.from.id, userId]
          ).catch((err: unknown) => {
            const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
            console.error('[telegram/link] чат не записан в карточку партнёра, SQLSTATE', code);
          });
        }

        // Отправляем персональное приветствие
        void sendWelcomeMessage(userId, {
          telegramId: update.message.from.id,
          name,
          role,
          isNewUser: false,
        });

        return;
      }

      // /start lead — турист хочет оставить заявку
      if (arg === 'lead') {
        const firstName = update.message?.from?.first_name ?? 'Путешественник';
        pendingLeadFlow.set(chatId, { firstName, startedAt: Date.now() });
        await sendHTML(chatId, [
          `<b>Привет, ${firstName}! Я — Кузьмич.</b>`,
          '',
          'Расскажите о своей поездке — подберу лучший тур:',
          '',
          '• Что хотите (вулканы, медведи, рыбалка, термалки...)',
          '• Примерные даты или сезон',
          '• Сколько человек',
          '• Примерный бюджет на всех',
          '',
          '<i>Пришлю персональное предложение прямо сюда через 1–2 минуты.</i>',
        ].join('\n'));
        return;
      }

      // /start без параметра — у привязанного прокатчика это кабинет, не меню туриста.
      if (!admin && await tryRentalCabinetTelegramMessage({
        chatId: update.message.chat.id,
        text: '/start',
        fromName: update.message.from?.first_name ?? null,
        send: (body, buttons) => sendRentalCabinet(chatId, body, buttons),
      })) {
        return;
      }
      if (!admin && await tryRoleMenuTelegramMessage({
        chatId: update.message.chat.id,
        text: '/start',
        fromName: update.message.from?.first_name ?? null,
        chatType,
        send: (body, buttons) => sendRoleRows(chatId, body, buttons),
        sendPersistent: (body) => sendOperatorKeyboard(chatId, body),
      })) {
        return;
      }

      // /start без параметра — проверяем знаем ли мы этого пользователя
      const linkedUser = await getUserByTelegramId(fromId);

      if (linkedUser) {
        const firstName = linkedUser.name.split(' ')[0];
        const roleLabel: Record<string, string> = {
          tourist: 'Рад снова видеть тебя',
          operator: 'Кабинет оператора',
          guide: 'Кабинет гида',
          agent: 'Кабинет агента',
          admin: 'Командный центр',
        };
        const greeting = [
          `<b>${roleLabel[linkedUser.role] ?? 'Привет'}, ${esc(firstName)}!</b>`,
          '',
          'Твой личный канал на Ведаре активен. Команды:',
          '/help — всё что я умею',
          '/route — случайный маршрут',
          '/weather — погода сейчас',
          '',
          'Или просто спроси — отвечу.',
        ].join('\n');
        if (!admin && linkedUser.role === 'tourist') await sendTourist(chatId, greeting);
        else await sendHTML(chatId, greeting);
      } else {
        const greeting = [
          '<b>Привет! Я — Кузьмич.</b>',
          '',
          'Помогаю спланировать поездку по Камчатке на Ведаре: маршрут, сезон, погода и туры из каталога.',
          '',
          'Кнопки внизу: подобрать тур, погода, аренда авто, операторы. Или пишите своими словами.',
          '',
          'Уже есть аккаунт на <a href="https://vedarai.ru">vedarai.ru</a>? Привяжите Telegram в профиле.',
        ].join('\n');
        if (admin) await sendHTML(chatId, greeting);
        else await sendTourist(chatId, greeting);
      }
      return;
    }

    // /login — magic link для входа на сайт (только для привязанных admin/operator/guide)
    if (text.startsWith('/login')) {
      const linkedUser = await getUserByTelegramId(fromId);
      if (!linkedUser) {
        await sendHTML(chatId, [
          '<b>Аккаунт не привязан.</b>',
          '',
          'Зарегистрируйся на <a href="https://vedarai.ru">vedarai.ru</a>',
          'и привяжи Telegram в разделе Профиль.',
        ].join('\n'));
        return;
      }

      // Генерируем magic token (15 минут)
      const { SignJWT } = await import('jose');
      const secret = new TextEncoder().encode('magic:' + (process.env.JWT_SECRET ?? ''));
      const magicToken = await new SignJWT({ userId: linkedUser.id })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('15m')
        .sign(secret);

      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
      const link = `${siteUrl}/api/auth/magic?token=${magicToken}`;

      await sendHTML(chatId, [
        `<b>Привет, ${linkedUser.name.split(' ')[0]}!</b>`,
        '',
        'Нажми кнопку ниже — войдёшь без пароля.',
        '<i>Ссылка действует 15 минут.</i>',
        '',
        `<a href="${link}">Войти в систему →</a>`,
      ].join('\n'));
      return;
    }

    // Команды кабинета туроператора и гида (/bookings) — раньше туристской справки.
    const deskHead = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!admin && (deskHead === '/help' || deskHead === '/requests' || deskHead === '/tours' || deskHead === '/seats'
      || deskHead === '/bookings')) {
      if (await tryRoleMenuTelegramMessage({
        chatId: update.message.chat.id,
        text,
        fromName: update.message.from?.first_name ?? null,
        chatType,
        send: (body, buttons) => sendRoleRows(chatId, body, buttons),
        sendPersistent: (body) => sendOperatorKeyboard(chatId, body),
      })) {
        return;
      }
    }

    // /help
    if (text.startsWith('/help')) {
      const adminBlock = admin
        ? '\n<b>Админ:</b>\n/stats — статистика\n/leads — последние заявки\n/groups — мониторинг групп\n/digest — AI дайджест\n/agent &lt;текст&gt; — PlatformAgent\n/post operator &lt;slug&gt;\n/post route &lt;uuid&gt;\n/post sezon — AI-пост в канал'
        : '';
      const helpText = [
        '<b>Команды Кузьмича:</b>',
        '',
        '/route — случайный маршрут из каталога',
        '/weather — погода в Петропавловске',
        '/tip — случайный совет',
        '/operators — список партнёров',
        '/sezon — совет по сезону',
        adminBlock,
        '',
        'Или просто напиши вопрос — отвечу как местный.',
        '',
        '<a href="https://vedarai.ru/routes">Все маршруты →</a>',
      ].filter(s => s !== '').join('\n');
      if (admin) await sendRoleRows(chatId, helpText, [adminMenu()]);
      else await sendHTML(chatId, helpText);
      return;
    }

    // /weather
    if (text.startsWith('/weather')) {
      const weather = await getWeather();
      await sendHTML(chatId, weather);
      return;
    }

    // /tip
    if (text.startsWith('/tip')) {
      const tip = await callAIWithModelDirect([
        { role: 'system', content: KUZMICH_SYSTEM + KUZMICH_TG_SUFFIX },
        { role: 'user', content: 'Дай один конкретный практический совет туристу, который едет на Камчатку первый раз. Не общие слова — что-то реально полезное из личного опыта.' },
      ], getModelForAgent('kuzmich'));
      await sendHTML(chatId, tip);
      return;
    }

    // /operators
    if (text.startsWith('/operators')) {
      const list = await touristOperatorsList();
      await sendHTML(chatId, list);
      return;
    }

    // /route
    if (text.startsWith('/route')) {
      const route = await getRandomRoute();
      if (!route) {
        await sendHTML(chatId, 'Маршруты загружаются. Загляни сам: <a href="https://vedarai.ru/routes">vedarai.ru/routes</a>');
      } else {
        const desc = route.description ? route.description.slice(0, 220).trimEnd() + '…' : '';
        await sendHTML(chatId, [
          `<b>${esc(route.title)}</b>`,
          '',
          desc,
          '',
          `<a href="https://vedarai.ru/routes/${route.id}">Подробнее на Ведаре →</a>`,
        ].filter(Boolean).join('\n'));
      }
      return;
    }

    // /sezon
    if (text.startsWith('/sezon')) {
      const month = new Date().toLocaleString('ru-RU', { month: 'long' });
      // Вопрос свой, но история разговора — туриста, и в ней бывают его
      // телефон и почта: тот же мозг и та же граница ПД (TG-BRAIN).
      await answerByKuzmich({
        chatId: update.message.chat.id,
        text: `Сейчас ${month}. Один конкретный совет: что стоит делать туристу на Камчатке прямо сейчас?`,
        userId: update.message.from?.id ?? null,
      });
      return;
    }

    // ── Admin-команды ─────────────────────────────────────────────────────────

    // /stats
    if (text.startsWith('/stats')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      const stats = await getStats();
      await sendHTML(chatId, stats);
      return;
    }

    // /leads
    if (text.startsWith('/leads')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      const leads = await getLastLeads();
      await sendHTML(chatId, leads);
      return;
    }

    // /groups — мониторинг Telegram-групп (только admin)
    if (text.startsWith('/groups')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      const groups = await groupMonitor.getMonitoredGroups();
      if (!groups.length) {
        await sendHTML(chatId, 'Группы ещё не добавлены.\n\nДобавь бота в туристическую группу в Telegram — он начнёт собирать разведку автоматически.\n\n<i>Не забудь отключить privacy mode в BotFather: /setprivacy → Disabled</i>');
        return;
      }
      const lines = ['<b>Мониторируемые группы:</b>', ''];
      for (const g of groups) {
        const lastAct = new Date(g.lastActivityAt).toLocaleDateString('ru-RU');
        lines.push(`📡 <b>${esc(g.title)}</b>`);
        lines.push(`   Сообщений: ${g.totalMessages}  ·  Активность: ${lastAct}`);
        lines.push(`   ID: <code>${g.id}</code>`);
        lines.push('');
      }
      const recent = await groupMonitor.getRecentIntel(5);
      if (recent.length > 0) {
        lines.push('<b>Последние находки:</b>', '');
        for (const r of recent) {
          const d = new Date(r.date).toLocaleDateString('ru-RU');
          lines.push(`📌 <b>${esc(r.group)}</b>  <i>${d}</i>  (${r.messages} сообщ.)`);
          if (r.intel.key_insights?.length) {
            r.intel.key_insights.slice(0, 2).forEach(i => lines.push(`   • ${esc(i)}`));
          }
          if (r.intel.hot_signals?.length) {
            r.intel.hot_signals.slice(0, 1).forEach(s => lines.push(`   🔥 ${esc(s)}`));
          }
          lines.push('');
        }
      }
      await sendHTML(chatId, lines.join('\n'));
      return;
    }

    // /digest — AI дайджест платформы (только admin)
    if (text.startsWith('/digest')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      await sendHTML(chatId, 'Формирую дайджест...');
      try {
        const digestText = await PlatformAgent.digest();
        await sendHTML(chatId, digestText);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendHTML(chatId, `Ошибка дайджеста: <code>${esc(msg)}</code>`);
      }
      return;
    }

    // /agent <text> — прямой вызов PlatformAgent (только admin)
    if (text.startsWith('/agent')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      const agentMsg = text.slice('/agent'.length).trim();
      if (!agentMsg) {
        await sendHTML(chatId, 'Использование: <code>/agent &lt;запрос&gt;</code>\nПример: <code>/agent мои туры</code>');
        return;
      }
      await sendHTML(chatId, 'Обрабатываю...');
      try {
        const result = await PlatformAgent.dispatch({ message: agentMsg, role: 'admin' });
        const header = `<i>intent: ${result.intent} | ${result.duration_ms}ms</i>\n\n`;
        await sendHTML(chatId, header + result.response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendHTML(chatId, `Ошибка агента: <code>${esc(msg)}</code>`);
      }
      return;
    }

    // /migrate — применить миграцию (только admin)
    if (text.startsWith('/migrate')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      try {
        await query(`
          ALTER TABLE leads
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','contacted','qualified','converted','lost')),
            ADD COLUMN IF NOT EXISTS notes TEXT,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, created_at DESC)`);
        await sendHTML(chatId, '✅ Migration 043 applied: leads.status + notes + updated_at');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendHTML(chatId, `❌ Migration error: <code>${esc(msg)}</code>`);
      }
      return;
    }

    // /diag — диагностика env vars (только admin)
    if (text.startsWith('/diag')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b>');
        return;
      }
      const vars = [
        ['TELEGRAM_BOT_TOKEN',      process.env.TELEGRAM_BOT_TOKEN],
        ['TELEGRAM_CHAT_ID',        process.env.TELEGRAM_CHAT_ID],
        ['TELEGRAM_CHANNEL_ID',     process.env.TELEGRAM_CHANNEL_ID],
        ['TELEGRAM_LEADS_CHAT_ID',  process.env.TELEGRAM_LEADS_CHAT_ID],
        ['ANTHROPIC_API_KEY',       process.env.ANTHROPIC_API_KEY],
        ['OPENROUTER_API_KEY',      process.env.OPENROUTER_API_KEY],
      ];
      const lines = ['<b>Env vars (✅ = задан, ❌ = не задан):</b>', ''];
      for (const [name, val] of vars) {
        const ok = val && val.trim().length > 0;
        const preview = ok ? ` <code>${String(val).slice(0, 6)}…</code>` : '';
        lines.push(`${ok ? '✅' : '❌'} <code>${name}</code>${preview}`);
      }
      await sendHTML(chatId, lines.join('\n'));
      return;
    }

    // /post
    if (text.startsWith('/post')) {
      if (!admin) {
        await sendHTML(chatId, '<b>Нет прав.</b> Команда только для администратора.');
        return;
      }
      const parts = text.split(/\s+/);
      const kind = parts[1];
      const arg  = parts[2];

      // /post sezon
      if (kind === 'sezon') {
        await sendHTML(chatId, 'Генерирую сезонный пост…');
        const result = await postSezonToChannel();
        await sendHTML(chatId, result.ok ? 'Сезонный пост опубликован.' : `Ошибка: ${result.error}`);
        return;
      }

      // /post friend <slug>
      if (kind === 'friend') {
        if (!arg) {
          await sendHTML(chatId, 'Используй: <code>/post friend soulful</code>');
          return;
        }
        await sendHTML(chatId, `Генерирую пост про друзей (${arg})…`);
        const result = await postFriendToChannel(arg);
        await sendHTML(chatId, result.ok ? 'Пост опубликован.' : `Ошибка: ${result.error ?? 'неизвестная'}`);
        return;
      }

      // /post agents — диаграмма + пост про агентную оркестрацию в @ai_hub_money
      if (kind === 'agents') {
        await sendHTML(chatId, 'Публикую пост про агентов в AI-канал…');
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const channel = process.env.TELEGRAM_AI_CHANNEL_ID?.trim();
        if (!token || !channel) {
          await sendHTML(chatId, 'TELEGRAM_BOT_TOKEN или TELEGRAM_AI_CHANNEL_ID не задан');
          return;
        }
        const base = (process.env.NEXT_PUBLIC_SITE_URL
          // Предикат общий (lib/config): регулярка без якоря считала внутренним
          // любой адрес, где подстрока встретилась хоть в query-параметре.
          // Порядок кандидатов оставлен свой: здесь SITE_URL старше APP_URL.
          || (process.env.NEXT_PUBLIC_APP_URL && !isTechnicalHost(process.env.NEXT_PUBLIC_APP_URL) ? process.env.NEXT_PUBLIC_APP_URL : null)
          || 'https://vedarai.ru').replace(/\/$/, '');
        const photoUrl = `${base}/images/social/agent-orchestration.png`;
        const caption = [
          '<b>20+ AI-агентов в одном проде: спорят, учатся, оркеструются</b>',
          '',
          'Большинство пишет один вызов LLM и зовёт это «агентом». У нас агенты работают командой. Четыре паттерна.',
          '',
          '<b>Состязательность:</b> лид разбирают трое — Bull (сигналы покупки), Bear (риски), Arbiter (взвешивает, даёт вероятность). Спор бьёт один промпт.',
          '',
          '<b>Общий мозг:</b> агенты пишут в общую память, утренний брифинг раздаёт всем. Scout находит пробел → issue → другой агент реализует.',
          '',
          '<b>Само-эволюция:</b> growth находит баг → evolution чинит → feedback выводит правило на будущее.',
          '',
          '<b>Оркестрация:</b> детерминированные пайплайны, guardrails: tsc+тесты, human-in-the-loop.',
          '',
          'Главный риск — не тупость, а уверенная выдумка. Деризкинг с нуля: факты безопасности только из БД, иначе честное «не знаю».',
        ].join('\n');
        const buttons = [
          [{ text: 'CLAUDE.md — конституция агентов', url: 'https://github.com/tourhabk-ui/pos/blob/main/CLAUDE.md' }],
          [{ text: 'Платформа на агентах', url: 'https://t.me/kamchatka_real' }],
        ];
        try {
          const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: channel,
              photo: photoUrl,
              // Тот же срез, что у прочих отправителей: слепой slice рвал теги
              // и оставлял голый `<`, а Bot API на такую подпись отвечает 400.
              caption: repairTelegramHtml(caption, TELEGRAM_CAPTION_LIMIT),
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: buttons },
            }),
            signal: AbortSignal.timeout(15000),
          });
          const data = await res.json() as { ok: boolean; description?: string };
          await sendHTML(chatId, data.ok ? 'Пост опубликован в AI-канал.' : `Ошибка: ${data.description ?? 'unknown'}\nURL: ${photoUrl}`);
        } catch (e) {
          await sendHTML(chatId, `Сбой: ${e instanceof Error ? e.message : 'fetch error'}`);
        }
        return;
      }

      if (!kind || !arg) {
        await sendHTML(chatId, [
          '<b>/post — публикация в канал</b>',
          '',
          '<code>/post operator kamchatskaya-rybalka</code>',
          '<code>/post route &lt;uuid&gt;</code>',
          '<code>/post sezon</code>  — AI сезонный пост',
          '<code>/post friend soulful</code>  — пост про друзей',
          '<code>/post agents</code>  — пост про агентную оркестрацию (AI-канал)',
        ].join('\n'));
        return;
      }

      let result: { ok: boolean; error?: string };
      if (kind === 'operator') {
        result = await postOperatorToChannel(arg);
      } else if (kind === 'route') {
        result = await postRouteToChannel(arg);
      } else {
        await sendHTML(chatId, 'Используй: <code>operator</code>, <code>route</code>, <code>sezon</code> или <code>friend</code>.');
        return;
      }
      await sendHTML(chatId, result.ok ? '✅ Пост опубликован.' : `❌ Ошибка: ${result.error ?? 'неизвестная'}`);
      return;
    }

    // Контроль выхода в Telegram не ставится: он собирает телефоны, а
    // политика конфиденциальности (разд. 5) обещает, что их здесь нет. На
    // разговор о нём — куда идти (lib/kuzmich/watch-flow.ts). Раньше эвристики
    // телефона ниже: «сообщите маме +7 914 …» иначе стало бы заявкой на тур.
    const watchRedirect = telegramWatchRedirect(text);
    if (watchRedirect) {
      await sendHTML(chatId, watchRedirect);
      return;
    }

    // «/partner почта» — привязка по почте закрыта (09.10). Второй вход и MAX
    // отвечают, как подключиться; живой вход молчал: текст с «/» дальше не
    // идёт никуда (проверка каналов 25.10).
    if (chatType === 'private' && /^\/partner(\s|@|$)/i.test(text)) {
      await sendHTML(chatId, PARTNER_EMAIL_BIND_CLOSED);
      return;
    }

    // Кабинет прокатчика — до мозга туриста. Просьба туриста в этом чате
    // остаётся Кузьмичу (boundChatLane внутри). Админский чат не перехватываем.
    if (!admin && !text.startsWith('/') && await tryRentalCabinetTelegramMessage({
      chatId: update.message.chat.id,
      text,
      fromName: update.message.from?.first_name ?? null,
      send: (body, buttons) => sendRentalCabinet(chatId, body, buttons),
    })) {
      return;
    }
    if (!admin && !text.startsWith('/') && await tryRoleMenuTelegramMessage({
      chatId: update.message.chat.id,
      text,
      fromName: update.message.from?.first_name ?? null,
      chatType,
      send: (body, buttons) => sendRoleRows(chatId, body, buttons),
    })) {
      return;
    }

    // Любой обычный текст → проверяю телефон или AI Кузьмич
    if (!text.startsWith('/')) {
      // Блок 112 — на каждом ответе туристу в этой ветке (аудит 15.10,
      // TG-BRAIN), а не только на ответе модели: «помогите, мы заблудились»
      // уходило в тикет поддержки со «сроком ответа до 2 часов» без единого
      // слова о 112. Шаблоны ниже не меняются — блок встаёт впереди и только
      // при признаках беды (lib/safety/sos-detector).
      const emergency = detectEmergency(text).detected;
      const withSos = (reply: string): string => withSosBlock(reply, text).text;

      // Кнопка клавиатуры — не текст заявки. Клавиатура остаётся на экране
      // после /start lead (ссылка сайта ?start=lead), и «Подобрать тур»
      // иначе записывался описанием поездки.
      const button = !admin ? matchTouristButton(text) : null;
      if (button) {
        await answerTouristButton(chatId, button);
        return;
      }

      // Пользователь в процессе оформления заявки через /start lead
      const pendingLead = pendingLeadFlow.get(chatId);
      if (pendingLead) {
        pendingLeadFlow.delete(chatId);
        await sendHTML(chatId, withSos([
          '✅ <b>Заявка принята!</b>',
          '',
          'Анализирую запрос, подбираю туры.',
          'Пришлю предложение прямо сюда через 1–2 минуты.',
        ].join('\n')));
        void createLeadFromTelegramFlow(
          chatId, pendingLead.firstName, fromId,
          update.message?.from?.username ?? null, text
        ).catch((err) => console.error('[tg webhook] createLeadFromTelegramFlow failed:', err));
        return;
      }

      // Check if text looks like phone number
      const phoneMatch = text.match(/[\d+\-() ]{7,}/);
      // Сообщение о беде с номером — не ответ на подборку туров (TG-BRAIN):
      // «мы заблудились, телефон …» после разговора о рыбалке становилось
      // «горячим лидом» операторам, а турист получал «оператор свяжется в
      // течение 1–2 часов» вместо 112. Такое сообщение идёт Кузьмичу.
      if (phoneMatch && !emergency) {
        const phoneText = phoneMatch[0].trim();
        // Интересы — из той же истории, что ведёт Кузьмич (tg_conversations)
        const history = await getHistory(update.message.chat.id, KUZMICH_TG_MODE);
        const lastIntests = extractLastInterestsFromHistory(history);

        if (lastIntests.interests && lastIntests.interests.length > 0) {
          // User responded with phone after seeing tours
          await createLeadFromBot(chatId, phoneText, lastIntests);
          await sendHTML(chatId, '✅ Спасибо! Оператор свяжется с вами в ближайшее время.');
          return;
        }
      }

      // Поддержка: обращение в тикет-систему
      if (isSupportRequest(text)) {
        const linkedUser = await getUserByTelegramId(fromId);

        if (linkedUser) {
          // Проверяем открытые тикеты
          const openTickets = await getUserOpenTickets(linkedUser.id);

          if (openTickets.length > 0) {
            // Добавляем сообщение к существующему тикету
            const ticket = openTickets[0];
            await addTicketMessage(ticket.id, { role: 'user', text });
            await sendHTML(chatId, withSos([
              `<b>Тикет #${ticket.id.slice(0, 8)} обновлён</b>`,
              '',
              `Категория: ${CATEGORY_LABELS[ticket.category]}`,
              `Статус: рассматривается Резидентом ${ticket.assignedAgent ?? 'Admin'}`,
              '',
              'Ответим в ближайшее время.',
            ].join('\n')));
          } else {
            // Создаём новый тикет
            const { category, resident } = categorizeSupport(text);
            const ticket = await createTicket({
              userId:       linkedUser.id,
              channel:      'telegram',
              subject:      text.slice(0, 100),
              firstMessage: text,
            });
            await sendHTML(chatId, withSos([
              '<b>Обращение принято!</b>',
              '',
              `Тикет: <code>#${ticket.id.slice(0, 8)}</code>`,
              `Категория: ${CATEGORY_LABELS[category]}`,
              '',
              RESIDENT_INTRO[resident] ?? `Назначен Резидент ${resident}.`,
              '',
              'Срок ответа: до 2 часов в рабочее время.',
              'Продолжай писать здесь — я передам ответ.',
            ].join('\n')));
          }
          return;
        } else if (!emergency) {
          // Незарегистрированный пользователь — направляем к регистрации.
          // В беде — не направляем: «зарегистрируйтесь» первым сообщением
          // человеку, который заблудился, только отодвигает ответ Кузьмича с
          // блоком 112 ниже (TG-BRAIN).
          await sendHTML(chatId, [
            'Для обращения в поддержку нужен аккаунт на Ведаре.',
            '',
            'Зарегистрируйся на <a href="https://vedarai.ru/auth/register">vedarai.ru</a> и привяжи Telegram в профиле.',
            'Или опиши проблему — помогу решить здесь.',
          ].join('\n'));
          // Не возвращаем — пусть Кузьмич тоже ответит
        }
      }

      // Admin free-form → keyword-only intent dispatch (без AI-классификации)
      if (admin) {
        const keywordIntent = classifyIntentByKeywords(text, 'admin');
        if (keywordIntent !== 'unknown') {
          try {
            const agentResult = await PlatformAgent.dispatch({ message: text, role: 'admin' });
            await sendHTML(chatId, withSos(agentResult.response));
            return;
          } catch (err) {
            // На ошибке агента отвечает Кузьмич; отказ агента — в лог.
            logSwallowedFailure('telegram/webhook', 'PlatformAgent по свободному тексту админа', err);
          }
        }
      }

      // Regular AI chat — общий мозг Кузьмича (TG-BRAIN)
      await answerByKuzmich({
        chatId: update.message.chat.id,
        text,
        userId: update.message.from?.id ?? null,
        tourist: !admin,
      });
      return;
    }
  }

  // ── callback_query (кнопки лидов + бронирования) ────────────────────────
  if (update.callback_query) {
    const cq             = update.callback_query;
    const senderChatId   = cq.from.id;
    const callbackChatId = String(cq.message?.chat?.id ?? senderChatId);
    const data           = cq.data ?? '';

    if (isOperatorDeskPayload(data)) {
      await telegramService.answerCallback(cq.id);
      const privateDesk = (cq.message?.chat?.type ?? 'private') === 'private';
      if (!privateDesk) {
        await sendHTML(callbackChatId, 'Кнопки кабинета работают в личном диалоге.');
        return;
      }
      const desk = await operatorDeskPress({
        channel: 'telegram',
        chatId: cq.message?.chat?.id ?? senderChatId,
        payload: data,
      });
      if (desk) await sendRoleRows(callbackChatId, desk.text, desk.buttons);
      return;
    }

    // Бронь и заявка своего тура кнопкой (гид, 29.10): вопрос `bk:` / `ld:`,
    // затем «Да» / «Не надо» `oc:`. Чат — только из сообщения с кнопкой, и
    // только личный: без сообщения право не проверить. Остальное проверяет
    // lib/bookings/chat-owner-action (карточка чата, аккаунт, человек
    // привязки, владение бронью и заявкой). Вебхук заверен секретом (webhook-secret).
    if (isOwnerPressPayload(data)) {
      await telegramService.answerCallback(cq.id);
      const pressChat = cq.message?.chat;
      if (!pressChat) {
        console.error('[telegram/webhook] кнопка брони без сообщения — не применена');
        await sendHTML(String(senderChatId), 'Это нажатие не засчитано: сообщение с кнопкой не найдено. Бронь и заявка не изменены — откройте «Брони» или «Входящие» ещё раз.');
        return;
      }
      const { handleOwnerPress } = await import('@/lib/bookings/chat-owner-action');
      const reply = await handleOwnerPress({
        channel: 'telegram',
        chatId: pressChat.id,
        privateChat: pressChat.type === 'private',
        presserId: senderChatId,
        payload: data,
      });
      await sendRoleRows(String(pressChat.id), reply.text, reply.buttons);
      return;
    }

    if (parseRentalCabinetPress(data) || data.startsWith('rr:')) {
      await telegramService.answerCallback(cq.id);
      await tryRentalCabinetTelegramPress({
        chatId: cq.message?.chat?.id ?? senderChatId,
        payload: data,
        send: (body, buttons) => sendRentalCabinet(callbackChatId, body, buttons),
      });
      return;
    }

    const rolePress = parseRoleMenuPress(data);
    if (rolePress) {
      await telegramService.answerCallback(cq.id);
      const privateChat = (cq.message?.chat?.type ?? 'private') === 'private';
      if (!privateChat) {
        await sendHTML(callbackChatId, 'Кнопки кабинета работают в личном диалоге.');
        return;
      }
      if (rolePress.role === 'admin') {
        const gate = await telegramAdminCallbackGate(senderChatId, isAdmin(senderChatId));
        if (gate === 'unchecked') {
          await sendHTML(callbackChatId, TELEGRAM_ADMIN_UNCHECKED);
          return;
        }
        if (gate === 'deny') {
          await sendHTML(callbackChatId, TELEGRAM_ADMIN_DENY);
          return;
        }
        const screen = await roleMenuScreen({
          role: 'admin', action: rolePress.action, channel: 'telegram', partner: null, nowMs: Date.now(),
        });
        await sendRoleRows(callbackChatId, screen.text, [adminMenu()]);
        return;
      }
      await tryRoleMenuTelegramPress({
        chatId: cq.message?.chat?.id ?? senderChatId,
        payload: data,
        send: (body, buttons) => sendRoleRows(callbackChatId, body, buttons),
        // Вид чата проверен выше; кнопки брони — только из сообщения в личном чате.
        privateChat: cq.message?.chat?.type === 'private',
      });
      return;
    }

    // ── Admin quick-action кнопки (из дайджеста) ──────────────────────────
    if (data.startsWith('admin:') && isAdmin(senderChatId)) {
      await telegramService.answerCallback(cq.id);
      const action = data.slice('admin:'.length);

      if (action === 'leads') {
        const leadsText = await getLastLeads();
        await sendHTML(callbackChatId, leadsText);
      } else if (action === 'stats') {
        const statsText = await getStats();
        await sendHTML(callbackChatId, statsText);
      } else if (action === 'bookings') {
        try {
          // Имя и телефон гостя не читаются: это Telegram (решение владельца
          // 23.08). Здесь — очередь броней и их состояние.
          const r = await query<{
            id: string; tour_title: string | null;
            booking_date: string; booking_status: string;
          }>(
            `SELECT ob.id::text, ot.title as tour_title,
                    ob.booking_date::text, ob.booking_status
             FROM operator_bookings ob
             LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
             ORDER BY ob.created_at DESC LIMIT 8`
          );
          if (!r.rows.length) {
            await sendHTML(callbackChatId, 'Бронирований пока нет.');
          } else {
            const lines = ['<b>Последние бронирования:</b>', ''];
            r.rows.forEach((b, i) => {
              const date = b.booking_date ? new Date(b.booking_date).toLocaleDateString('ru-RU') : '—';
              lines.push(`${i + 1}. <code>${esc(b.id)}</code>  [${b.booking_status}]`);
              if (b.tour_title) lines.push(`   ${esc(b.tour_title)}  ${date}`);
            });
            lines.push('', 'Имя и телефон гостя — в MAX и в кабинете.');
            await sendHTML(callbackChatId, lines.join('\n'));
          }
        } catch {
          await sendHTML(callbackChatId, 'Не удалось загрузить бронирования.');
        }
      } else if (action === 'help') {
        await sendHTML(callbackChatId, [
          '<b>Команды Кузьмича (admin):</b>',
          '',
          '/stats — статистика платформы',
          '/leads — последние заявки',
          '/digest — AI-дайджест сейчас',
          '/agent &lt;текст&gt; — PlatformAgent',
          '/post sezon | operator &lt;slug&gt; | route &lt;id&gt;',
          '/diag — диагностика env',
          '',
          'Или просто напиши запрос — Кузьмич поймёт.',
          'Примеры: "покажи лиды за сегодня", "сколько пользователей"',
        ].join('\n'));
      }
      return;
    }

    // ── Кнопки статуса лида (только admin) ────────────────────────────────
    // Карта действий — общая с MAX-вебхуком (lib/leads/status-action.ts):
    // две копии разошлись бы молча.
    const leadPrefix = Object.keys(LEAD_STATUS_ACTIONS).find(p => data.startsWith(p + ':'));
    if (leadPrefix) {
      if (!isAdmin(senderChatId)) {
        await telegramService.answerCallback(cq.id, 'Нет прав');
        return;
      }
      const leadId = data.slice(leadPrefix.length + 1);
      const res = await applyLeadStatus(leadPrefix, leadId);
      if (res.outcome === 'updated') {
        // Имя туриста в подтверждение не подставляем: это Telegram.
        await telegramService.answerCallback(cq.id, res.label);
        await sendHTML(callbackChatId, `Заявка <code>${leadId}</code> — статус: <b>${res.label}</b>`);
      } else if (res.outcome === 'not_found') {
        await telegramService.answerCallback(cq.id, 'Лид не найден');
      } else {
        await telegramService.answerCallback(cq.id, 'Не удалось изменить статус');
        await sendHTML(callbackChatId, `Статус заявки <code>${leadId}</code> не изменён: ${res.reason}`);
      }
      return;
    }

    // Кнопок confirm_/cancel_ не шлёт никто (заявка оператору уходит со
    // ссылкой «Открыть бронь»), а ловец ждал UUID при числовых id броней и
    // пускал любого партнёра с Telegram к ЛЮБОЙ брони. Снят 25.09 (§10.09:
    // обработчик без производителя). Подтверждение — кабинет оператора.
    await telegramService.answerCallback(cq.id);

    return;
  }

  return;
}
