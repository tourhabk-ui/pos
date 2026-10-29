/**
 * POST /api/telegram/kuzmich
 *
 * Многофункциональный Telegram-бот Кузьмич:
 * - Личные чаты: полный функционал (гид, бронирование, SOS, голос, фото)
 * - Групповые чаты: парсер лидов — молчит, пока не услышит туристический запрос
 * - Владелец: admin pipeline (PlatformAgent + approve/reject)
 *
 * v3 (апрель 2026):
 *  - Голосовые сообщения → Gemini transcription
 *  - Группы → group_listener mode
 *  - callback_query → рейтинги 👍/👎
 *  - Регистрация группы оператора: /register_group
 */

import { NextRequest, NextResponse } from 'next/server';
import { type PendingBooking, cleanupPending, hasLiveBookingFlow, processMessage, isBookingTrigger } from '@/lib/kuzmich/core';
import { boundChatContext, boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { adminChatYieldsToPartner } from '@/lib/roles/admin-partner-chat';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { findPartnerByChat, partnerGreeting, processPartnerMessage, PARTNER_EMAIL_BIND_CLOSED } from '@/lib/kuzmich/operator-chat';
import { parseRentalCabinetPress, rentalCabinetAsk, telegramCabinetMarkup, type CabinetButton } from '@/lib/rental/cabinet-bar';
import { openRentalCabinetScreen } from '@/lib/rental/cabinet-screen';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { menuMarkup, type MenuButton } from '@/lib/roles/chat-menu';
import {
  handleTelegramAdminTurn,
  TELEGRAM_ADMIN_DENY,
  TELEGRAM_ADMIN_UNCHECKED,
  telegramAdminCallbackGate,
} from '@/lib/telegram/admin-chat';
import { adminMenu, menuRoleOf, parseRoleMenuPress, partnerMenu, roleMenuAsk } from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import { tryRoleMenuTelegramPress } from '@/lib/roles/role-telegram';
import { isCabinetPayload } from '@/lib/chat-cabinet/payload';
import { telegramCabinetKeyboard } from '@/lib/chat-cabinet/render';
import { cabinetSectionFor } from '@/lib/chat-cabinet/service';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { datesSellerOf, telegramDatesText } from '@/lib/operators/chat-dates/texts';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { PlatformAgent } from '@/lib/agents';
import { pool } from '@/lib/db-pool';
import { groupMonitor } from '@/lib/telegram/group-monitor';
import { verifyWebhookSecret, refuseUnconfiguredWebhook } from '@/lib/telegram/webhook-secret';
import { getSetting } from '@/lib/platform-settings';
import { stripTags } from '@/lib/html/text';
import { sanitizeForTelegram } from '@/lib/telegram/kuzmich-format';
import { handlePartnerStart } from '@/lib/partners/bind-channel';
import { partnerLinkArgFromText } from '@/lib/partners/channel-link';
import { handleMemberStart } from '@/lib/operators/member-channel';
import { statusTokenFromStart, touristBindReplyText } from '@/lib/seat-requests/core';
import { bindTouristChat } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

// ── In-memory state ───────────────────────────────────────────────────────────

const pending = new Map<number, PendingBooking>();
setInterval(() => cleanupPending(pending), 5 * 60 * 1000);

// Deduplicate Telegram retries — store last 500 update_ids, flush every 10 min
const processedUpdates = new Set<number>();
setInterval(() => processedUpdates.clear(), 10 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
async function botToken(): Promise<string> {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  if (!_cachedToken) _cachedToken = await getSetting('telegram_bot_token');
  return _cachedToken ?? '';
}

function roleRows(buttons: MenuButton[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.payload }))) };
}

async function tgReply(chatId: number, text: string, extra?: Record<string, unknown>): Promise<void> {
  const token = await botToken();
  if (!token) return;
  const clean = sanitizeForTelegram(text);
  const url = `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`;
  const base = { chat_id: chatId, disable_web_page_preview: true, ...extra };

  // Attempt 1: HTML
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, text: clean, parse_mode: 'HTML' }),
    });
    const json = await res.json() as { ok: boolean; description?: string };
    if (json.ok) return;

    // Attempt 2: plain text fallback (strip all HTML tags)
    const plain = stripTags(clean);
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, text: plain }),
    });
    const json2 = await res2.json() as { ok: boolean; description?: string };
    if (!json2.ok) {
      console.error('[tgReply] fallback failed:', json2.description);
    }
  } catch (err) {
    console.error('[tgReply] network error:', err instanceof Error ? err.message : err);
  }
}

async function tgAnswerCallback(callbackQueryId: string, text?: string): Promise<void> {
  const token = await botToken();
  if (!token) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

// ── Действия по лиду из уведомления (#65) ─────────────────────────────────────
//
// Владелец одобряет предложение прямо в мессенджере. Право нажатия проверено
// вызывающим (сообщение принадлежит админ-чату). Идемпотентность — на стороне
// доставки: статус proposal_sent не даст отправить клиенту дважды, сколько бы
// раз ни нажали и сколько бы раз Telegram ни повторил апдейт.
async function handleLeadAction(
  action: string,
  leadId: string,
  callbackId: string,
  chatId: number,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
    await tgAnswerCallback(callbackId, 'Неверный идентификатор лида');
    return;
  }

  try {
    if (action === 'lead_send') {
      const { sendProposalToClient } = await import('@/lib/leads/proposal-delivery');
      const outcome = await sendProposalToClient(leadId);
      await tgAnswerCallback(callbackId, outcome.message.slice(0, 200));
      if (outcome.ok) await tgReply(chatId, `Предложение ушло клиенту. ${outcome.message}`);
      return;
    }

    if (action === 'lead_ai') {
      await tgAnswerCallback(callbackId, 'Запустил AI-обработку');
      const { leadProcessor } = await import('@/lib/services/operators/lead-processor.service');
      const { notifyOperatorProposal } = await import('@/lib/notifications/lead-notify');
      // Предложение придёт отдельным уведомлением — уже с кнопкой отправки.
      const proposal = await leadProcessor.process(leadId);
      await notifyOperatorProposal(proposal);
      return;
    }

    await tgAnswerCallback(callbackId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    await tgAnswerCallback(callbackId, 'Не получилось');
    await tgReply(chatId, `Действие по лиду не выполнено: ${msg.slice(0, 300)}`);
  }
}

// ── /start с клавиатурой быстрых тем ──────────────────────────────────────────

async function sendStartMessage(chatId: number, name: string | null): Promise<void> {
  const greeting = name ? `Привет, ${name}!` : 'Привет!';
  const text = [
    `${greeting} Я Кузьмич — помощник Ведара по Камчатке.`,
    '',
    '<b>Что умею:</b>',
    '- Подобрать тур: рыбалка, вулканы, медведи, термальные источники...',
    '- Открыть заявку на тур прямо в чате',
    '- Рассказать про маршруты, сезоны, снаряжение',
    '- Предупредить об опасностях на маршруте',
    '- Определить место по фото',
    '',
    'Выбери тему или пиши своими словами.',
  ].join('\n');

  await tgReply(chatId, text, {
    reply_markup: {
      keyboard: [
        ['Рыбалка', 'Вулканы'],
        ['Медведи', 'Термальные источники'],
        ['Вертолётный тур', 'Помощь'],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

/** Heuristic: answer looks like a concrete tour description (recommends something specific) */
function hasTourRecommendation(answer: string): boolean {
  const t = answer.toLowerCase();
  const hasTourWord = /\bтур\b|маршрут|рыбалк|вулкан|медвед|термал|гейзер|восхожден|экскурс/.test(t);
  const hasDetail = /\d+[\s\u00a0]*(р|руб|₽|ч\b|час|дн|день|дней|км|чел)/.test(t) || t.includes('стоимость') || t.includes('цена') || t.includes('от ') || t.includes('забронир');
  return hasTourWord && hasDetail && answer.length > 120;
}

async function sendBookingInlineButton(chatId: number): Promise<void> {
  const token = await botToken();
  if (!token) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Хотите оформить заявку на тур?',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Хочу оставить заявку', callback_data: 'book_now' },
        ]],
      },
    }),
  }).catch(() => {});
}

async function afterAiReply(chatId: number, answer?: string): Promise<void> {
  // Под ответом с блоком 112 заявку не предлагаем: совет при пропаже группы
  // называет «маршрут», и кнопка тура вставала прямо под тревогой.
  if (answer && !/(?<!\d)112(?!\d)/.test(answer) && hasTourRecommendation(answer)) {
    await sendBookingInlineButton(chatId);
  }
}

// ── Скачать файл из Telegram → base64 ────────────────────────────────────────

async function downloadTgFile(fileId: string): Promise<{ base64: string; mimeType: string; ext: string } | null> {
  const token = await botToken();
  if (!token) return null;
  try {
    const fileRes = await fetch(
      `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/getFile?file_id=${fileId}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const fileJson = await fileRes.json() as { ok: boolean; result?: { file_path?: string } };
    const filePath = fileJson.result?.file_path;
    if (!filePath) return null;

    const imgRes = await fetch(
      `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/file/bot${token}/${filePath}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!imgRes.ok) return null;

    const buf = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';

    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp',
      ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mp3',
      m4a: 'audio/m4a', wav: 'audio/wav',
    };
    return { base64, mimeType: mimeMap[ext] ?? 'application/octet-stream', ext };
  } catch { return null; }
}

// ── Owner admin pipeline ──────────────────────────────────────────────────────

async function handleApproval(cmd: string, chatId: number): Promise<void> {
  const isApprove = cmd.startsWith('/approve_');
  const shortId = cmd.replace(/^\/(approve|reject)_/, '');
  if (shortId.length < 7) { await tgReply(chatId, 'Неверный формат.'); return; }

  try {
    const { rows } = await pool.query<{ id: string; description: string; action_type: string }>(
      `SELECT id, description, action_type FROM agent_approvals WHERE id LIKE $1 AND status = 'pending' LIMIT 1`,
      [shortId + '%'],
    );
    if (!rows[0]) { await tgReply(chatId, `Инициатива <code>${shortId}</code> не найдена.`); return; }
    const { id, description, action_type } = rows[0];

    await pool.query(
      `UPDATE agent_approvals SET status = $1, execution_status = $2, reviewed_at = NOW(),
       review_notes = $3 WHERE id = $4`,
      [isApprove ? 'approved' : 'rejected',
       isApprove ? 'assigned' : 'rejected',
       `${isApprove ? 'Approved' : 'Rejected'} via Telegram bot`,
       id],
    );
    await tgReply(chatId,
      `<b>${isApprove ? 'Одобрено' : 'Отклонено'}</b>\n\nТип: <code>${action_type}</code>\n${description}`
    );
  } catch (err) {
    await tgReply(chatId, `Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOwnerCommand(cmd: string, text: string, chatId: number): Promise<void> {
  if (cmd === '/help' || cmd === '/start') {
    await tgReply(chatId, '<b>Admin режим</b>\n\n/kuzmich — пост о маршруте\n/tip — совет\n/sezon — сезонный пост\n/safety — пост о безопасности\n/approve_XXX / /reject_XXX — инициативы');
    return;
  }
  if (cmd === '/kuzmich' || cmd === '/tip' || cmd === '/sezon' || cmd === '/safety') {
    await tgReply(chatId, 'Публикую...');
    const mod = await import('@/lib/notifications/telegram-channel');
    const fn = cmd === '/kuzmich' ? mod.postKuzmichRoute
      : cmd === '/tip' ? mod.postKuzmichTip
      : cmd === '/safety' ? mod.postSafetyToChannel
      : mod.postSezonToChannel;
    const topic = cmd === '/safety' ? text.replace(/^\/safety\s*/i, '').trim() || undefined : undefined;
    const r = cmd === '/safety' ? await fn(topic) : await fn();
    await tgReply(chatId, r.ok ? 'Опубликовано' : `Ошибка: ${r.error}`);
    return;
  }
  // Free text → PlatformAgent
  try {
    // userId не передаётся: TELEGRAM_OWNER_ID — id в Telegram, а не users.id (UUID).
    const result = await PlatformAgent.dispatch({ message: text, role: 'admin' });
    await tgReply(chatId, result.response);
  } catch (err) {
    await tgReply(chatId, `Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Рейтинг: сохранить в БД ───────────────────────────────────────────────────

async function saveRating(chatId: number, mode: string, rating: 1 | 5): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tg_ratings (chat_id, mode, rating) VALUES ($1, $2, $3)`,
      [chatId, mode, rating],
    );
  } catch { /* не критично */ }
}

// ── Парсер лидов (групповой чат) ─────────────────────────────────────────────

const GROUP_TRIGGERS = [
  'хочу', 'хотим', 'сколько стоит', 'можно', 'есть ли', 'когда', 'как попасть',
  'интересует', 'рыбалк', 'вулкан', 'медвед', 'термал', 'вертолет', 'снегоход',
  'тур', 'экскурс', 'бронир', 'цена', 'стоимость',
  'want', 'how much', 'price', 'book', 'tour', 'fishing', 'volcano',
];

function hasTouristIntent(text: string): boolean {
  const t = text.toLowerCase();
  return GROUP_TRIGGERS.some(tr => t.includes(tr));
}

async function processGroupMessage(opts: {
  chatId: number;
  fromId: number;
  fromName: string | null;
  text: string;
}): Promise<void> {
  const { chatId, fromId, fromName, text } = opts;

  if (!hasTouristIntent(text)) return; // молчим

  // Краткий AI-ответ в группе
  const { buildTourContext, KUZMICH_SYSTEM } = await import('@/lib/kuzmich/core');
  const { callAIWaterfall } = await import('@/lib/ai/providers');

  const tourCtx = await buildTourContext();
  const systemContent = `${KUZMICH_SYSTEM}\n\n${tourCtx}\n\nТы в групповом чате. Отвечай коротко (2-3 строки). Чтобы оставить заявку оператору, приглашай писать в личку боту.`;

  const messages = [
    { role: 'system' as const, content: systemContent },
    { role: 'user' as const, content: text },
  ];

  const answer = await callAIWaterfall(messages);
  const botUsername = process.env.TELEGRAM_KUZMICH_USERNAME ?? 'kuzmichai_bot';
  const reply = (answer?.trim() || 'Напишите мне в личку — подберу тур!') +
    `\n\n<a href="https://t.me/${botUsername}">Написать Кузьмичу →</a>`;

  await tgReply(chatId, reply);

  // Уведомление о лиде оператору группы или платформе
  const operatorTgId = await getGroupOperatorId(chatId);
  const notifyId = operatorTgId ?? parseInt(process.env.TELEGRAM_OWNER_ID ?? '0', 10);

  if (notifyId) {
    const leadText = [
      '<b>Новый лид из группы</b>',
      `Имя: ${fromName ?? 'неизвестно'} (ID: ${fromId})`,
      `Запрос: ${text.slice(0, 200)}`,
      `Группа: ${chatId}`,
    ].join('\n');
    await tgReply(notifyId, leadText);
  }
}

async function getGroupOperatorId(groupId: number): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ telegram_id: string }>(
      `SELECT u.telegram_id FROM tg_operator_groups g
       JOIN users u ON u.id = g.operator_id
       WHERE g.group_id = $1 LIMIT 1`,
      [groupId],
    );
    if (rows[0]?.telegram_id) return parseInt(rows[0].telegram_id, 10);
  } catch { /* таблица может ещё не существовать */ }
  return null;
}

async function registerGroup(groupId: number, groupTitle: string | null, chatId: number): Promise<void> {
  // Находим оператора по его Telegram ID
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE telegram_id = $1 LIMIT 1`,
      [String(chatId)],
    );
    const operatorId = rows[0]?.id;
    if (!operatorId) {
      await tgReply(chatId, 'Не найден аккаунт оператора. Убедитесь что ваш Telegram привязан в профиле vedarai.ru');
      return;
    }
    await pool.query(
      `INSERT INTO tg_operator_groups (group_id, operator_id, group_title)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id) DO UPDATE SET operator_id = $2, group_title = $3`,
      [groupId, operatorId, groupTitle],
    );
    await tgReply(chatId, `Группа зарегистрирована. Кузьмич будет мониторить туристические запросы и присылать лиды вам.`);
  } catch (err) {
    await tgReply(chatId, `Ошибка регистрации: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Типы Telegram Update ──────────────────────────────────────────────────────

interface TgPhotoSize  { file_id: string; width: number; height: number }
interface TgVoice      { file_id: string; duration: number; mime_type?: string }
interface TgVideoNote  { file_id: string; duration: number }

interface TgUpdate {
  update_id?: number;
  message?: {
    chat:    { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
    from?:   { id: number; first_name?: string; last_name?: string };
    text?:   string;
    caption?: string;
    photo?:  TgPhotoSize[];
    voice?:  TgVoice;
    video_note?: TgVideoNote;
  };
  channel_post?: {
    chat:    { id: number; type: string; title?: string };
    text?:   string;
    caption?: string;
  };
  callback_query?: {
    id:   string;
    from: { id: number };
    data: string;
    message?: { chat: { id: number; type?: string } };
  };
}

// ── POST: Webhook ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Подлинность webhook. Второй слой к проверке выше по коду: секрет — это
  // единственное, что в запросе нельзя подделать, тогда как from.id и chat.id
  // пишет тот, кто стучится. Свой секрет на бота, не общий: один секрет на два
  // бота означает, что компрометация одного открывает второго.
  //
  // Не задан — отказ 503 (аудит 15.10, P3-03). Прежнее «работаем, иначе
  // Кузьмич замолчит для туристов» (#1168) снято замером с прода: туристам
  // отвечает /api/telegram/webhook (его секрет задан), а этот роут вебхуком не
  // зарегистрирован — без секрета он был открытой дверью и ничьим ботом.
  const verdict = verifyWebhookSecret(
    request.headers.get('x-telegram-bot-api-secret-token'),
    process.env.TELEGRAM_KUZMICH_WEBHOOK_SECRET,
  );
  if (verdict === 'forbidden') return new NextResponse(null, { status: 401 });
  if (verdict === 'not_configured') {
    return refuseUnconfiguredWebhook('telegram/kuzmich', 'TELEGRAM_KUZMICH_WEBHOOK_SECRET');
  }

  try {
    const update = await request.json() as TgUpdate;

    // Skip Telegram retries for already-processed updates
    if (update.update_id !== undefined) {
      if (processedUpdates.has(update.update_id)) {
        return NextResponse.json({ ok: true });
      }
      processedUpdates.add(update.update_id);
    }

    // ── callback_query: рейтинги ─────────────────────────────────────
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat.id ?? cq.from.id;

      if (parseRentalCabinetPress(cq.data) || cq.data.startsWith('rr:')) {
        await tgAnswerCallback(cq.id);
        const { tryRentalCabinetTelegramPress } = await import('@/lib/rental/cabinet-telegram');
        await tryRentalCabinetTelegramPress({
          chatId,
          payload: cq.data,
          send: async (body, buttons) => {
            await tgReply(chatId, body, { reply_markup: telegramCabinetMarkup(buttons) });
          },
        });
        return NextResponse.json({ ok: true });
      }

      // Кабинет в чате (lib/chat-cabinet): на этом входе экран приходит новым
      // сообщением. Личный чат, карточку и владение проверяет сервис.
      if (isCabinetPayload(cq.data)) {
        await tgAnswerCallback(cq.id);
        const { handleCabinetPress } = await import('@/lib/chat-cabinet/service');
        const screen = await handleCabinetPress({
          channel: 'telegram', chatId, privateChat: cq.message?.chat?.type === 'private', payload: cq.data,
        });
        await tgReply(chatId, screen.text, { reply_markup: telegramCabinetKeyboard(screen.rows) });
        return NextResponse.json({ ok: true });
      }

      if (parseRoleMenuPress(cq.data)) {
        await tgAnswerCallback(cq.id);
        const press = parseRoleMenuPress(cq.data);
        if (press?.role === 'admin') {
          const pressedIn = cq.message?.chat?.type;
          if (pressedIn === 'group' || pressedIn === 'supergroup' || pressedIn === 'channel') {
            await tgReply(chatId, 'Кнопки кабинета работают в личном диалоге.');
            return NextResponse.json({ ok: true });
          }
          const legacy = [process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_OWNER_ID]
            .some((id) => id !== undefined && id !== '' && id === String(cq.from.id));
          const gate = await telegramAdminCallbackGate(cq.from.id, legacy);
          if (gate === 'unchecked') {
            await tgReply(chatId, TELEGRAM_ADMIN_UNCHECKED);
            return NextResponse.json({ ok: true });
          }
          if (gate === 'deny') {
            await tgReply(chatId, TELEGRAM_ADMIN_DENY);
            return NextResponse.json({ ok: true });
          }
          const screen = await roleMenuScreen({
            role: 'admin', action: press.action, channel: 'telegram', partner: null, nowMs: Date.now(),
          });
          await tgReply(chatId, screen.text, { reply_markup: menuMarkup(adminMenu()) });
          return NextResponse.json({ ok: true });
        }
        await tryRoleMenuTelegramPress({
          chatId,
          payload: cq.data,
          send: async (body, buttons) => {
            if (buttons.length === 0) await tgReply(chatId, body);
            else await tgReply(chatId, body, { reply_markup: roleRows(buttons) });
          },
          sendCabinet: async (screen) => {
            await tgReply(chatId, screen.text, { reply_markup: telegramCabinetKeyboard(screen.rows) });
          },
          privateChat: cq.message?.chat?.type === 'private',
        });
        return NextResponse.json({ ok: true });
      }

      if (cq.data === 'rate_good') {
        await saveRating(chatId, 'tourist', 5);
        await tgAnswerCallback(cq.id, 'Спасибо!');
        await tgReply(chatId, 'Рад помочь! Если понадоблюсь — пиши.');
      } else if (cq.data === 'rate_bad') {
        await saveRating(chatId, 'tourist', 1);
        await tgAnswerCallback(cq.id, 'Принято, буду лучше');
        await tgReply(chatId, 'Жаль. Расскажи что не так — постараюсь исправить.');
      } else if (cq.data === 'book_now') {
        await tgAnswerCallback(cq.id);
        await processMessage({
          chatId, text: 'Хочу забронировать тур',
          userName: null, userId: cq.from.id,
          mode: 'tourist', createdVia: 'telegram_inline',
          pending, reply: tgReply, platform: 'tg',
        });
      } else if (cq.data.startsWith('lead_send:') || cq.data.startsWith('lead_ai:')) {
        // Действия по лиду (#65). Право нажатия — принадлежность сообщения
        // админ-чату, которому это уведомление и адресовано: from.id прислал
        // бы кто угодно, а chat сообщения с кнопкой подделать нельзя.
        const adminChat = process.env.TELEGRAM_CHAT_ID ?? '';
        if (!adminChat || String(chatId) !== adminChat) {
          await tgAnswerCallback(cq.id, 'Действие доступно только в рабочем чате');
        } else {
          const [action, leadId] = cq.data.split(':');
          await handleLeadAction(action, leadId ?? '', cq.id, chatId);
        }
      } else {
        await tgAnswerCallback(cq.id);
      }
      return NextResponse.json({ ok: true });
    }

    // ── channel_post: мониторинг каналов ──────────────────────────────
    if (update.channel_post) {
      const cp = update.channel_post;
      const text = cp.text ?? cp.caption ?? '';
      if (text && text.length >= 10) {
        groupMonitor.processMessage(
          String(cp.chat.id),
          cp.chat.title ?? 'Канал',
          'channel',
          text,
        );
      }
      return NextResponse.json({ ok: true });
    }

    const msg = update.message;
    if (!msg) return NextResponse.json({ ok: true });

    const chatId    = msg.chat.id;
    const fromId    = msg.from?.id ?? 0;
    const fromName  = msg.from?.first_name ?? null;
    const chatType  = msg.chat.type;
    const ownerId   = parseInt(process.env.TELEGRAM_OWNER_ID ?? '0', 10);
    const isPrivate = chatType === 'private';
    const isGroup   = chatType === 'group' || chatType === 'supergroup';

    const sayAdmin = async (body: string, buttons?: MenuButton[][]) => {
      const row = buttons?.[0];
      if (row?.length) await tgReply(chatId, body, { reply_markup: menuMarkup(row) });
      else await tgReply(chatId, body);
    };

    // Ссылка администратора adt_ — раньше консоли владельца: иначе «Старт»
    // по ссылке из админки ушёл бы в /approve_. Чужой /start (op_, sr_) не
    // забирается. Группа сюда не входит.
    if (isPrivate && fromId > 0 && msg.text && /^\/start\s+\S/.test(msg.text.trim())) {
      const turn = await handleTelegramAdminTurn({
        text: msg.text.trim(),
        fromId,
        nowMs: Date.now(),
        reply: sayAdmin,
      });
      if (turn === 'handled') return NextResponse.json({ ok: true });
    }

    // ── Владелец в личке → admin pipeline ─────────────────────────────────
    //
    // Ветка открывает PlatformAgent с role:'admin' и публикацию в канал, а
    // условие входа — `fromId === ownerId`, где `from.id` приходит В ТЕЛЕ
    // ЗАПРОСА. Ответ раньше уходил в `msg.chat.id`, тоже из тела: подделав оба
    // поля, посторонний получал admin-ответы себе в чат. Это тот же дефект,
    // что закрыт в /api/telegram/admin; чинить одну дверь из двух — не чинить
    // (сама находка #1158 предупреждала: «иначе дыра просто переезжает»).
    //
    // Адресат — ownerId. Для владельца в личке это то же число, что chat.id,
    // поэтому его работа не меняется; для подделки — данные уходят владельцу,
    // а не тому, кто их запросил. Обычные (не-владельческие) ветки ниже
    // по-прежнему отвечают в chat.id: Кузьмич — публичный бот, и там это
    // единственный правильный адрес.
    if (isPrivate && fromId === ownerId && msg.text) {
      const text = msg.text.trim();
      const cmd  = text.split(' ')[0]?.toLowerCase() ?? '';
      if (cmd.startsWith('/approve_') || cmd.startsWith('/reject_')) {
        await handleApproval(cmd, ownerId);
      } else {
        await handleOwnerCommand(cmd, text, ownerId);
      }
      return NextResponse.json({ ok: true });
    }

    // ── ГРУППА: /register_group или парсер лидов + разведка ─────────
    if (isGroup) {
      const text = msg.text ?? msg.caption ?? '';
      if (text.toLowerCase().startsWith('/register_group')) {
        await registerGroup(chatId, msg.chat.title ?? null, fromId);
        return NextResponse.json({ ok: true });
      }
      // Intelligence: тихий мониторинг в фоне
      if (text && text.length >= 10) {
        groupMonitor.processMessage(String(chatId), msg.chat.title ?? 'Группа', fromName ?? 'Участник', text);
      }
      // Lead detection: отвечаем только при явном туристическом интересе
      if (text) await processGroupMessage({ chatId, fromId, fromName, text });
      return NextResponse.json({ ok: true });
    }

    // ── ЛИЧКА: /start с аргументом — ссылки подключения ──────────────────
    // Та же цепочка, что в /api/telegram/webhook и в MAX-боте: оператор по
    // ссылке администратора (op_, lib/partners/bind-channel), менеджер команды
    // кабинета (om_, lib/operators/member-channel), турист за ответом на
    // запрос мест (sr_, lib/seat-requests). До 15.10 этот обработчик знал
    // только голый /start: ссылка «подключить Telegram» открывала бота, а
    // «Старт» уходил в туристский поток — человек видел ответ Кузьмича вместо
    // привязки (оператор «Местечко», 15.10: «ссылка на телегу не рабочая»).
    // У одного бота два обработчика, и ссылка обязана работать при любом.
    // Стоит ДО ветки партнёра: ссылка меняет адрес, а уже привязанный чат
    // ответил бы приветствием. Прочие аргументы (lead, route_…) — ниже, как
    // и раньше.
    // Голое «op_…» — тот же аргумент, что «/start op_…»: веб-клиент иногда
    // отдаёт код обычным сообщением, без команды. Чужие префиксы (om_, sr_)
    // разборщик не узнаёт, и они идут прежним путём /start ниже.
    const typedLink = isPrivate && msg.text ? partnerLinkArgFromText(msg.text) : null;
    if (isPrivate && msg.text && (typedLink !== null || /^\/start\s+\S/.test(msg.text.trim()))) {
      const arg = typedLink ?? msg.text.trim().slice('/start'.length).trim();
      const reply = (t: string) => tgReply(chatId, t);
      // Личный чат: кто открыл ссылку — для входа на сайт через Telegram (1336).
      // В личном чате id чата равен id человека; иначе владелец не пишется.
      const opener = typeof msg.from?.id === 'number' && msg.from.id > 0 && msg.from.id === chatId ? msg.from.id : null;
      if (await handlePartnerStart(arg, 'telegram', chatId, async (t, buttons) => {
        // Строка проката (rk:) — своей разметкой, со своей строкой кабинета.
        // Строка меню гида (rm:gd:) — как есть: строку проката к ней не клеим.
        const rows = (buttons ?? []).map((row) => [...row]);
        const rental = rows.some((row) => row.some((b) => b.payload.startsWith('rk:')));
        if (rows.length && rental) await tgReply(chatId, t, { reply_markup: telegramCabinetMarkup(rows) });
        else if (rows.length) {
          await tgReply(chatId, t, {
            reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.payload }))) },
          });
        }
        else await reply(t);
      }, opener)) return NextResponse.json({ ok: true });
      if (await handleMemberStart(arg, 'telegram', chatId, reply)) return NextResponse.json({ ok: true });
      const seatToken = statusTokenFromStart(arg);
      if (seatToken !== null) {
        await reply(touristBindReplyText(await bindTouristChat(seatToken, 'telegram', chatId)));
        return NextResponse.json({ ok: true });
      }
    }

    // ── ЛИЧКА: /partner EMAIL — привязка по почте закрыта (09.10) ─────────
    // Отвечаем, как подключиться, а не роняем в туристский поток: оператор,
    // следующий старой инструкции, должен узнать, что делать дальше.
    if (isPrivate && msg.text?.trim().toLowerCase().startsWith('/partner')) {
      await tgReply(chatId, PARTNER_EMAIL_BIND_CLOSED);
      return NextResponse.json({ ok: true });
    }

    // Привязанный администратор — раньше кабинета партнёра. Владелец этой
    // двери остаётся на своей консоли выше: /approve_ не должен уйти в меню.
    // «Не смог проверить» — pass, обычный путь. Группа уже вышла и таблицу
    // не спрашивает.
    if (isPrivate && fromId > 0 && fromId !== ownerId) {
      const turn = await handleTelegramAdminTurn({
        text: msg.text?.trim() ?? null,
        fromId,
        nowMs: Date.now(),
        reply: sayAdmin,
        liveBooking: () => hasLiveBookingFlow(chatId, 'tourist', pending),
        yieldToPartner: (t) => adminChatYieldsToPartner('telegram', chatId, t),
      });
      if (turn === 'handled') return NextResponse.json({ ok: true });
      if (turn === 'tourist' && msg.text) {
        await processMessage({
          chatId, text: msg.text.trim(), userName: fromName,
          userId: fromId, mode: 'tourist', createdVia: 'telegram',
          pending, reply: tgReply, platform: 'tg', afterReply: afterAiReply,
        });
        return NextResponse.json({ ok: true });
      }
    }

    // ── ЛИЧКА: партнёр? ──────────────────────────────────────────────────
    // Проверяем до туристского flow: если chatId есть в partners.telegram_chat_id.
    // «Не смогли проверить» (база не ответила) записано в лог самой проверкой
    // и ведёт в туристский поток: остановить из-за него всех туристов хуже,
    // чем ответить партнёру как туристу один раз.
    const lookup = isPrivate ? await findPartnerByChat('telegram', chatId) : null;
    const partner = lookup?.outcome === 'found' ? lookup.partner : null;
    // Та же развилка, что в MAX: просьба туриста (аренда, тур, трансфер,
    // план поездки) идёт Кузьмичу туриста, кабинет — помощнику партнёра.
    // Заявка, начатая здесь у Кузьмича туриста, доводится им же: ответы
    // «Иван Петров», «15 июля» иначе ушли бы помощнику кабинета (#2756).
    if (partner && msg.text && !(await hasLiveBookingFlow(chatId, 'tourist', pending))
      && boundChatLaneFor('telegram', chatId, msg.text, boundChatContext(partner)) !== 'tourist') {
      const text = msg.text.trim();
      const pilot = isRentalPilotSlug(partner.slug);
      const menu = partnerMenu(partner);
      // Беда в тексте — блок 112 над любым ответом кабинета, как на живом входе.
      const say = async (raw: string, buttons: CabinetButton[][] = []) => {
        const body = withSosBlock(raw, text).text;
        if (pilot) await tgReply(chatId, body, { reply_markup: telegramCabinetMarkup(buttons) });
        else if (menu) await tgReply(chatId, body, { reply_markup: menuMarkup(menu, buttons) });
        else await tgReply(chatId, body);
      };
      const role = menuRoleOf(partner);
      if (role && (text === '/start' || roleMenuAsk(text) !== null)) {
        const asked = roleMenuAsk(text);
        if (text === '/start' || asked === 'help') {
          const screen = await roleMenuScreen({ role, action: 'help', channel: 'telegram', partner, nowMs: Date.now() });
          await say(screen.text);
        } else {
          // Вкладка кабинета в чате; прочие слова меню — «Входящие», как раньше.
          const screen = await cabinetSectionFor(partner, 'telegram', asked === 'tasks' || asked === 'clients' ? asked : 'inbox');
          await tgReply(chatId, withSosBlock(screen.text, text).text, { reply_markup: telegramCabinetKeyboard(screen.rows) });
        }
      } else if (text === '/start') {
        await say(partnerGreeting(partner));
      } else if (sellsOwnTours(partner) && chatDatesIntent(text) === 'dates'
        && await (await import('@/lib/operators/chat-dates/flow')).isOperatorDatesPhrase(text, partner.partnerId)) {
        // «Открой даты словами» (22.10) — только в MAX: там есть кнопка
        // подтверждения. Здесь записи нет, и помощник фразу не получает —
        // он сказал бы «открыл», не открыв. Гиду со своими турами (29.10) —
        // так же, со ссылкой в его раздел «Свои туры».
        await say(telegramDatesText(datesSellerOf(partner)));
      } else if (pilot && (rentalCabinetAsk(text) === 'requests' || rentalCabinetAsk(text) === 'edits' || rentalCabinetAsk(text) === 'help')) {
        const asked = rentalCabinetAsk(text);
        if (asked) {
          await openRentalCabinetScreen({
            action: asked,
            partner: { partnerId: partner.partnerId, partnerName: partner.partnerName, slug: partner.slug },
            channel: 'telegram',
            dialog: true,
            send: say,
          });
        }
      } else if (await (await import('@/lib/rental/car-calendar-flow')).handleRentalCalendarText({
        partner, text, nowMs: Date.now(), dialog: true, canMark: false,
        send: async (body, buttons) => { await say(body, buttons); },
      })) {
        // Календарь проката читается и здесь. Кнопок отметки в Telegram нет:
        // «Свободна» / «Занята» пишутся в MAX, и текст это говорит.
      } else {
        await processPartnerMessage({
          chatId, text, fromName, partner,
          reply: async (id, body) => { await say(body); void id; },
        });
      }
      return NextResponse.json({ ok: true });
    }

    // ── ЛИЧКА: турист ─────────────────────────────────────────────────────

    // /start — отправляем приветствие с клавиатурой быстрых тем (без processMessage)
    if (msg.text?.trim() === '/start') {
      await sendStartMessage(chatId, fromName);
      return NextResponse.json({ ok: true });
    }

    // Определяем рейтинг из текстовых эмодзи
    if (msg.text) {
      const t = msg.text.trim();
      if (t === '👍' || t.toLowerCase() === 'круто' || t.toLowerCase() === 'спасибо') {
        await saveRating(chatId, 'tourist', 5);
        await tgReply(chatId, 'Отлично! Пиши если что.');
        return NextResponse.json({ ok: true });
      }
      if (t === '👎') {
        await saveRating(chatId, 'tourist', 1);
        await tgReply(chatId, 'Жаль. Что можно улучшить?');
        return NextResponse.json({ ok: true });
      }
    }

    // Голосовое сообщение → транскрипция → processMessage
    if (msg.voice || msg.video_note) {
      const fileId = msg.voice?.file_id ?? msg.video_note?.file_id ?? '';
      await tgReply(chatId, 'Слушаю...');

      // Два отказа — две разные фразы. «Не разобрал» — про дикцию, и повторить
      // осмысленно; «распознавание недоступно» — про нас, и повторять
      // бессмысленно. Одна фраза на оба случая с 07.09 заставляла человека
      // переговаривать в пустоту: OpenRouter с прода отвечает 403, и голос не
      // расшифровывался вовсе (§4.0 — «не смог» не выдаётся за «плохо слышно»).
      let transcription: string | undefined;
      let voiceFailure: 'unintelligible' | 'unavailable' = 'unavailable';
      try {
        const fileData = await downloadTgFile(fileId);
        if (fileData) {
          const { callGeminiTranscribe } = await import('@/lib/ai/providers');
          const outcome = await callGeminiTranscribe(fileData.base64, fileData.mimeType);
          if (outcome.ok) transcription = outcome.text;
          else voiceFailure = outcome.reason;
        }
      } catch { /* не критично */ }

      if (!transcription) {
        await tgReply(chatId, voiceFailure === 'unintelligible'
          ? 'Не разобрал голосовое. Напишите текстом?'
          : 'Распознавание речи сейчас недоступно — напишите, пожалуйста, текстом.');
        return NextResponse.json({ ok: true });
      }

      await tgReply(chatId, `<i>Вы сказали: ${transcription}</i>`);
      await processMessage({
        chatId, text: transcription, userName: fromName,
        userId: fromId, mode: 'tourist', createdVia: 'telegram_voice',
        pending, reply: tgReply,
        platform: 'tg', afterReply: afterAiReply,
      });
      return NextResponse.json({ ok: true });
    }

    // Фото → Gemini Vision → processMessage
    if (msg.photo?.length) {
      const bestPhoto = msg.photo[msg.photo.length - 1];
      await tgReply(chatId, 'Смотрю на фото...');

      let visionDescription: string | undefined;
      try {
        const photoData = await downloadTgFile(bestPhoto.file_id);
        if (photoData) {
          // Что видно и факты места из базы — одно правило на все каналы.
          const { describeKuzmichPhoto } = await import('@/lib/kuzmich/photo-vision');
          visionDescription = await describeKuzmichPhoto(photoData.base64, photoData.mimeType) ?? undefined;
        }
      } catch (err) {
        // Ответ без фото лучше, чем никакой; но отказ виден в логе.
        console.error('[telegram/kuzmich] фото не разобрано', err instanceof Error ? err.message : err);
      }

      await processMessage({
        chatId, text: msg.caption?.trim() ?? 'Что это за место?',
        userName: fromName, userId: fromId, mode: 'tourist',
        createdVia: 'telegram', pending, reply: tgReply, visionDescription,
        platform: 'tg', afterReply: afterAiReply,
      });
      return NextResponse.json({ ok: true });
    }

    // Текст
    if (msg.text) {
      await processMessage({
        chatId, text: msg.text.trim(), userName: fromName,
        userId: fromId, mode: 'tourist', createdVia: 'telegram',
        pending, reply: tgReply,
        platform: 'tg', afterReply: afterAiReply,
      });
    }

  } catch { /* Telegram требует 200 OK всегда */ }

  return NextResponse.json({ ok: true });
}
