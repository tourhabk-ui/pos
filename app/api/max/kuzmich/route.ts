/**
 * POST /api/max/kuzmich
 * Бот Кузьмич для MAX мессенджера (VK).
 *
 * Два режима:
 *   POST — обработка webhook-апдейтов от MAX
 *   GET  — long-polling: забирает апдейты и обрабатывает (для cron / dev)
 *
 * Env vars: MAX_BOT_TOKEN
 */

import { NextRequest, NextResponse } from 'next/server';
import { Bot, type Api } from '@maxhub/max-bot-api';
import { type PendingBooking, cleanupPending, processMessage } from '@/lib/kuzmich/core';
import { registerOperatorMaxChatId, findOperatorByMaxChatId } from '@/lib/kuzmich/operator-chat';
import { pool } from '@/lib/db-pool';
import { createLead } from '@/lib/leads/create';
import { authenticateMaxLoginSession } from '@/lib/auth/max-login';
import { isVerifiedMaxWebhook } from '@/lib/max/webhook-url';

type ButtonIntent = 'default' | 'positive' | 'negative';
type MaxButton =
  | { type: 'callback'; text: string; payload: string; intent?: ButtonIntent }
  | { type: 'link'; text: string; url: string }
  | { type: 'request_contact'; text: string };

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
    const bot = new Bot(token);
    _api = bot.api;
  }
  return _api;
}

// ── Reply via MAX API ─────────────────────────────────────────────────────────

async function maxReply(chatId: number, text: string): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    await api.sendMessageToChat(chatId, text, { format: 'html' });
  } catch { /* не блокируем */ }
}

async function maxReplyWithButtons(chatId: number, text: string, buttons: MaxButton[][]): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    await (api.sendMessageToChat as (chatId: number, text: string, opts: unknown) => Promise<unknown>)(chatId, text, {
      format: 'html',
      attachments: [{ type: 'inline_keyboard', payload: { buttons } }],
    });
  } catch { /* не блокируем */ }
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

// Создать лид из MAX-контакта
async function createLeadFromContact(
  chatId: number,
  phone: string,
  name: string,
  comment: string,
): Promise<void> {
  try {
    await createLead({
      name: name || 'Турист',
      phone,
      comment,
      source_url: 'https://max.ru',
      source_data: { source: 'max_bot', max_chat_id: chatId, timestamp: new Date().toISOString() },
      status: 'new',
    });
  } catch { /* не блокируем */ }
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
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? 'application/octet-stream';
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString('base64'), mimeType: ct.split(';')[0].trim() };
  } catch { return null; }
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

// ── Обработка одного апдейта ──────────────────────────────────────────────────

async function handleUpdate(update: MaxUpdate, opts?: { verifiedOrigin?: boolean }): Promise<void> {
  // bot_started → вход через MAX (deep-link ?start=login-<nonce>) ИЛИ обычный /start
  if (update.update_type === 'bot_started' && update.chat_id) {
    const startPayload = update.payload ?? '';
    if (startPayload.startsWith('login-')) {
      // ЗАЩИТА ОТ ЗАХВАТА АККАУНТА (security-ревью #961, HIGH): подтверждать
      // вход можно ТОЛЬКО по апдейту, чей источник заверен — иначе форжнутый
      // POST с чужим max_user_id логинит атакующего под жертвой. Заверенные
      // пути: webhook с секретом в URL (isVerifiedMaxWebhook) и long-polling
      // (мы сами забрали апдейт у MAX по токену). Fail-closed.
      if (!opts?.verifiedOrigin) {
        await maxReply(update.chat_id, 'Вход через MAX временно недоступен. Попробуйте позже.');
        return;
      }
      const nonce = startPayload.slice('login-'.length);
      const ok = await authenticateMaxLoginSession(nonce, {
        maxUserId: update.user?.user_id ?? update.chat_id,
        name: update.user?.name ?? null,
        username: update.user?.username ?? null,
      });
      await maxReply(
        update.chat_id,
        ok
          ? 'Вход подтверждён. Вернитесь на сайт — вы уже авторизованы.'
          : 'Ссылка для входа устарела или уже использована. Начните вход на сайте заново.',
      );
      return;
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

    // Фото → Gemini Vision
    const photoAtt = attachments.find(a => a.type === 'image');
    if (photoAtt?.payload?.url) {
      await maxReply(chatId, 'Смотрю на фото...');
      let visionDescription: string | undefined;
      try {
        const mediaData = await downloadMedia(photoAtt.payload.url);
        if (mediaData) {
          const { callGeminiVision } = await import('@/lib/ai/providers');
          visionDescription = await callGeminiVision(
            mediaData.base64, mediaData.mimeType,
            'Опиши что на фото: место, природа, деятельность. Если это Камчатка — укажи конкретно что это. Кратко, 2-3 предложения.',
          ) ?? undefined;
        }
      } catch { /* не критично */ }

      await processMessage({
        chatId, text: text || 'Что это за место?',
        userName, userId, mode: 'max',
        createdVia: 'max', pending, reply: maxReply, visionDescription,
        platform: 'max',
      });
      return;
    }

    // Голос / аудио → Gemini Transcribe
    const audioAtt = attachments.find(a => a.type === 'audio');
    if (audioAtt?.payload?.url) {
      await maxReply(chatId, 'Слушаю...');
      let transcription: string | undefined;
      try {
        const mediaData = await downloadMedia(audioAtt.payload.url);
        if (mediaData) {
          const { callGeminiTranscribe } = await import('@/lib/ai/providers');
          transcription = await callGeminiTranscribe(mediaData.base64, mediaData.mimeType) ?? undefined;
        }
      } catch { /* не критично */ }

      if (!transcription) {
        await maxReply(chatId, 'Не разобрал голосовое. Напишите текстом?');
        return;
      }

      await maxReply(chatId, `<i>Вы сказали: ${transcription}</i>`);
      await processMessage({
        chatId, text: transcription, userName, userId,
        mode: 'max', createdVia: 'max_voice', pending, reply: maxReply,
        platform: 'max',
      });
      return;
    }

    // Видео → описание через Vision
    const videoAtt = attachments.find(a => a.type === 'video');
    if (videoAtt?.payload?.url) {
      await maxReply(chatId, 'Видео пока не умею анализировать. Опишите словами или пришлите фото.');
      return;
    }

    // Контакт → создаём лид
    const contactAtt = attachments.find(a => a.type === 'contact');
    if (contactAtt) {
      const vcf = contactAtt.payload?.vcf_info ?? '';
      const phone = parsePhoneFromVcf(vcf)
        ?? contactAtt.payload?.tam_info?.user_id?.toString()
        ?? null;
      const contactName = contactAtt.payload?.tam_info?.name ?? userName ?? 'Турист';

      if (phone) {
        await createLeadFromContact(chatId, phone, contactName, 'Заявка из MAX бота');
        await maxReply(chatId,
          `Отлично, ${contactName}! Номер получен.\n\nОператор свяжется с вами в течение <b>1-2 часов</b> по номеру <b>${phone}</b>.`,
        );
      } else {
        await maxReply(chatId, 'Не удалось получить номер. Напишите его текстом, пожалуйста.');
      }
      return;
    }

    // Регистрация оператора: /partner EMAIL или партнер EMAIL
    const lc = text.toLowerCase();
    const partnerPrefix = lc.startsWith('/partner ') ? '/partner '
      : lc.startsWith('партнер ') ? 'партнер '
      : lc.startsWith('партнёр ') ? 'партнёр '
      : lc.startsWith('оператор ') ? 'оператор '
      : null;
    if (partnerPrefix) {
      const email = text.slice(partnerPrefix.length).trim();
      if (email.includes('@')) {
        const name = await registerOperatorMaxChatId(chatId, email);
        if (name) {
          await maxReply(chatId, `Привет, ${name}! Ты подключён как оператор в MAX.\n\nБуду присылать уведомления о новых бронированиях сюда. Также могу отвечать на вопросы о турах и статистике. Пиши.`);
        } else {
          await maxReply(chatId, 'Email не найден в системе. Проверь адрес или напиши на vedarai.ru.');
        }
      } else {
        await maxReply(chatId, 'Напиши: партнер email@example.com');
      }
      return;
    }

    // Текст
    if (text) {
      // Operator mode: if sender is a registered operator — route to operator assistant
      const operator = await findOperatorByMaxChatId(chatId);
      if (operator) {
        const { processOperatorMessage } = await import('@/lib/kuzmich/operator-chat');
        await processOperatorMessage({ chatId, text, fromName: userName, operator, reply: maxReply });
        return;
      }

      let capturedReply = '';
      const capturingReply = async (id: number, msg: string) => {
        capturedReply = msg;
        await maxReply(id, msg);
      };
      await processMessage({
        chatId, text, userName, userId,
        mode: 'max', createdVia: 'max', pending, reply: capturingReply,
        platform: 'max',
      });
      if (capturedReply && hasTourRecommendation(capturedReply)) {
        await maxReplyWithButtons(chatId, 'Хотите оформить заявку?', BOOKING_BUTTONS);
      }
    }
    return;
  }

  // message_callback → нажатие inline-кнопки
  if (update.update_type === 'message_callback' && update.callback) {
    const api = getApi();
    if (!api) return;

    const payload = update.callback.payload ?? '';
    // В callback-апдейте chat_id берётся из message.recipient.chat_id
    const callbackChatId: number | null | undefined = update.message?.recipient.chat_id;

    // Подтверждаем получение
    await api.answerOnCallback(update.callback.callback_id, {
      notification: '',
    }).catch(() => {});

    // callbackChatId may be null if callback update has no message — fall back to user_id (DM = user_id in MAX)
    const resolvedChatId = callbackChatId ?? update.callback.user.user_id;
    if (!resolvedChatId) return;

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
      });
      if (capturedReply && hasTourRecommendation(capturedReply)) {
        await maxReplyWithButtons(resolvedChatId, 'Хотите оформить заявку?', BOOKING_BUTTONS);
      }
      return;
    }

    // Кнопка "Оформить заявку"
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
  try {
    const body = await request.json();

    // MAX может отправить один апдейт или массив
    const updates: MaxUpdate[] = Array.isArray(body) ? body : [body];

    // Источник заверен, если запрос пришёл на URL с webhook-секретом,
    // который знаем только мы и MAX (см. lib/max/webhook-url). Обычные
    // сообщения обрабатываем в любом случае, а вот подтверждение ВХОДА
    // требует заверенного источника (защита от захвата аккаунта).
    const verifiedOrigin = isVerifiedMaxWebhook(request.url);

    for (const update of updates) {
      await handleUpdate(update, { verifiedOrigin });
    }
  } catch { /* всегда 200 OK */ }

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
