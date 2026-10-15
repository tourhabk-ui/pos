/**
 * lib/telegram/operator-availability.ts
 *
 * Свободные места у операторов для Кузьмича + watchdog Telegram-вебхука.
 *
 * ЧТЕНИЕ TG-ГРУПП ОТСЮДА УБРАНО (решение владельца 19.09). Файл читал группы
 * операторов через MTProto от имени ЛИЧНОГО аккаунта владельца, а ключи
 * TG_API_ID / TG_API_HASH / TG_USER_SESSION не были заданы ни разу с заведения
 * модуля (17.05): `fetchGroupAvailability` не выполнялся никогда, и кеш
 * сигналов в `agent_memory` (`tg_avail_*`) не получил ни одной строки.
 *
 * Вместе с транспортом ушёл и ЧИТАТЕЛЬ этого кеша внутри
 * `searchOperatorAvailability`: у него не осталось производителя, а читатель
 * без производителя — «объявленный исход без источника» (CLAUDE.md §4). Ветка
 * с `tour_availability`, которая и отвечала Кузьмичу все эти месяцы, осталась
 * единственной и теперь названа своим именем.
 *
 * Живое здесь:
 *   `searchOperatorAvailability` — свободные места из `tour_availability`;
 *   `publicWebhookBase` / `checkAndRestoreWebhook` — вебхук Bot API.
 *
 * Сторож: tests/unit/mtproto-purged.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { isTechnicalHost } from '@/lib/config';
import { escapeHtml } from '@/lib/text/escape-html';

// ── Уведомление владельцу ────────────────────────────────────────────────────

/**
 * Сообщение владельцу. Возвращает, ушло ли оно: тревога, которая не ушла,
 * не должна выглядеть отправленной (§4.0), поэтому отказ пишется в лог.
 */
async function notifyOwner(text: string): Promise<boolean> {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? '171286547';
  if (!token) {
    console.error('[telegram-webhook-watchdog] тревога владельцу не ушла: TELEGRAM_BOT_TOKEN не задан');
    return false;
  }
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    ownerId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[telegram-webhook-watchdog] тревога владельцу не ушла: sendMessage HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[telegram-webhook-watchdog] тревога владельцу не ушла:', e instanceof Error ? e.message : e);
    return false;
  }
}
// ── Свободные места для Кузьмича ─────────────────────────────────────────────

/**
 * Свободные места по запросу Кузьмича — из `tour_availability`, то есть из
 * того, что оператор подтвердил на платформе.
 *
 * Пустая строка — честное «нечего показать»: Кузьмич не вставляет блок вовсе,
 * а не пишет «мест нет» (это разные утверждения).
 */
export async function searchOperatorAvailability(query: string): Promise<string> {
  if (!query || query.length < 3) return '';

  try {
    const { rows } = await pool.query<{
      title: string;
      date: string;
      available_slots: number;
      company_name: string;
    }>(
      `SELECT ot.title, ta.date::text, ta.available_slots, p.company_name
         FROM tour_availability ta
         JOIN operator_tours ot ON ot.id = ta.operator_tour_id
         JOIN partners p ON p.id = ot.operator_id
        WHERE ta.date >= CURRENT_DATE
          AND ta.available_slots > 0
          AND ta.is_cancelled = false
        ORDER BY ta.date ASC
        LIMIT 10`,
    );

    if (rows.length === 0) return '';

    const lines = rows.map(r =>
      `${r.title} — ${r.date} — ${r.available_slots} мест (${r.company_name})`
    );
    return `=== Свободные места (из базы) ===\n${lines.join('\n')}`;
  } catch (e) {
    // Отказ не глушится (§4.0): «запрос упал» не должно читаться как «мест нет».
    console.error('[operator-availability] свободные места не прочитаны:', e instanceof Error ? e.message : e);
    return '';
  }
}


// ── Watchdog: проверка и восстановление Telegram-вебхука ─────────────────────

/**
 * Как идёт доставка сообщений боту — по записи самого Telegram
 * (`last_error_date` / `last_error_message` в getWebhookInfo).
 *
 * До 15.10 сторож смотрел только адрес вебхука и очередь. Утром 15.10 Telegram
 * не достучался до сервера («Connection timed out»), партнёр нажал /start
 * дважды и ответа не получил, а сторож отвечал «ok»: адрес верный, очередь
 * пуста — ошибку, которую Telegram записал, он не читал вовсе.
 *
 *   none      — Telegram ошибок не записал;
 *   stale     — последняя ошибка была до прошлой проверки, её уже видели;
 *   single    — свежая ошибка, одна: Telegram повторит доставку сам, тревоги нет;
 *   repeating — свежая ошибка, и прошлая проверка тоже видела свою свежую:
 *               доставка падает раз за разом;
 *   stuck     — свежая ошибка, а обновления копятся: люди ждут ответа.
 *
 * Тревога владельцу — на `repeating` и `stuck`. Одна сетевая осечка, которую
 * Telegram сам доставил повтором, тревогой не будит, но видна в ответе крона
 * и в `agent_run_history`, и следующая проверка по ней узнает повтор.
 */
export type DeliveryVerdict = 'none' | 'stale' | 'single' | 'repeating' | 'stuck';

const DELIVERY_VERDICTS: readonly DeliveryVerdict[] = ['none', 'stale', 'single', 'repeating', 'stuck'];
const FRESH_VERDICTS: readonly DeliveryVerdict[] = ['single', 'repeating', 'stuck'];

/**
 * Свежесть ошибки, когда момент прошлой проверки неизвестен: крон ходит раз в
 * 30 минут, запас — 5. Известен — свежая та, что случилась после него
 * (планировщик GitHub Actions задерживает прогоны на часы, CLAUDE.md §8).
 */
export const FRESH_ERROR_WINDOW_MS = 35 * 60_000;

/** Что записала прошлая проверка. */
export interface PreviousDeliveryCheck {
  checked_at: string | null;
  delivery: DeliveryVerdict | null;
  last_error_at: string | null;
}

/** null — прошлых проверок нет; 'unknown' — прочитать их не удалось. */
export type PreviousDeliveryInput = PreviousDeliveryCheck | null | 'unknown';

export function judgeDeliveryError(args: {
  /** ISO момента последней ошибки; null — Telegram момента не записал. */
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  pending: number;
  nowMs: number;
  previous: PreviousDeliveryInput;
}): DeliveryVerdict {
  const { lastErrorAt, lastErrorMessage, pending, nowMs, previous } = args;
  if (!lastErrorAt) {
    // Текст ошибки без момента — ошибка была, когда — неизвестно. «Ошибок
    // нет» здесь было бы неправдой; судим как одну свежую.
    return lastErrorMessage ? 'single' : 'none';
  }
  const errorMs = Date.parse(lastErrorAt);
  const prevMs = previous && previous !== 'unknown' && previous.checked_at
    ? Date.parse(previous.checked_at)
    : NaN;
  const freshSince = Number.isFinite(prevMs) ? prevMs : nowMs - FRESH_ERROR_WINDOW_MS;
  if (Number.isFinite(errorMs) && errorMs <= freshSince) return 'stale';
  if (pending > 0) return 'stuck';
  if (
    previous && previous !== 'unknown'
    && previous.delivery && FRESH_VERDICTS.includes(previous.delivery)
    && previous.last_error_at && previous.last_error_at !== lastErrorAt
  ) {
    return 'repeating';
  }
  return 'single';
}

export function isDeliveryVerdict(v: unknown): v is DeliveryVerdict {
  return typeof v === 'string' && (DELIVERY_VERDICTS as readonly string[]).includes(v);
}

/**
 * Последняя проверка из `agent_run_history`. Отказ базы — 'unknown' с
 * SQLSTATE в логе: «не смог прочитать» не равно «проверок не было».
 */
export async function readPreviousDeliveryCheck(): Promise<PreviousDeliveryInput> {
  try {
    const { rows } = await pool.query<{ checked_at: string | null; delivery: string | null; last_error_at: string | null }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at,
              metadata->>'delivery'      AS delivery,
              metadata->>'last_error_at' AS last_error_at
         FROM agent_run_history
        WHERE agent_id = 'telegram-webhook-watchdog'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      checked_at: row.checked_at,
      delivery: isDeliveryVerdict(row.delivery) ? row.delivery : null,
      last_error_at: row.last_error_at,
    };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'нет кода';
    console.error(`[telegram-webhook-watchdog] прошлая проверка не прочитана (SQLSTATE ${code}):`, e instanceof Error ? e.message : e);
    return 'unknown';
  }
}

/** Время по Камчатке для сообщения владельцу: «15.10, 08:38». */
function kamchatkaTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'время не записано';
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function deliveryAlertText(args: {
  verdict: 'repeating' | 'stuck';
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  pending: number;
}): string {
  const lines = [
    '<b>Telegram не доставляет сообщения боту</b>',
    '',
    `Ошибка: ${escapeHtml(args.lastErrorMessage ?? 'текст не записан')}`,
    `Последняя: ${args.lastErrorAt ? `${kamchatkaTime(args.lastErrorAt)} по Камчатке` : 'время не записано'}`,
    `В очереди: ${args.pending}`,
    '',
    args.verdict === 'stuck'
      ? 'Сообщения копятся: люди пишут боту и ждут ответа.'
      : 'Ошибки повторяются: прошлая проверка тоже видела свежую.',
    'Адрес вебхука верный, переустановка не поможет. Смотреть доступность сервера и ответ /api/telegram/webhook.',
  ];
  return lines.join('\n');
}

export interface WebhookCheckResult {
  status: 'ok' | 'restored' | 'failed';
  current_url: string | null;
  expected_url: string;
  pending_update_count: number;
  /** Последняя ошибка доставки по записи Telegram; null — не записана. */
  last_error_at?: string | null;
  last_error_message?: string | null;
  delivery?: DeliveryVerdict;
  /** Тревога о доставке: ушла, не ушла, не требовалась (null). */
  delivery_alert?: 'sent' | 'not_sent' | null;
  /** Прошлую проверку прочитать не удалось — повтор не мог быть узнан. */
  previous_check?: 'unknown';
  action?: string;
  error?: string;
}

const PENDING_UPDATES_THRESHOLD = 100;

/**
 * Публичный базовый URL для вебхука Telegram.
 * NEXT_PUBLIC_APP_URL на Timeweb = внутренний хостнейм (*.twc1.net), который
 * Telegram не может разрезолвить ("Failed to resolve host"). Поэтому для вебхука
 * берём публичный домен: явный TELEGRAM_WEBHOOK_URL → NEXT_PUBLIC_SITE_URL →
 * NEXT_PUBLIC_APP_URL (если он не внутренний) → дефолт. Внутренние *.twc1.net отбрасываем.
 */
export function publicWebhookBase(): string {
  // Предикат общий с getPublicBaseUrl: третья реализация одного правила
  // судила по регулярке БЕЗ якоря — `https://example.com/?x=twc1.net` для неё
  // был внутренним хостом (js/regex/missing-regexp-anchor). Список кандидатов
  // здесь свой намеренно: вебхуку нужен ещё и TELEGRAM_WEBHOOK_URL.
  const isInternal = isTechnicalHost;
  const candidates = [
    process.env.TELEGRAM_WEBHOOK_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    isInternal(process.env.NEXT_PUBLIC_APP_URL) ? null : process.env.NEXT_PUBLIC_APP_URL,
  ];
  const picked = candidates.find(u => u && !isInternal(u));
  return (picked ?? 'https://vedarai.ru').replace(/\/$/, '');
}

export async function checkAndRestoreWebhook(
  opts: { previous?: PreviousDeliveryInput; nowMs?: number } = {},
): Promise<WebhookCheckResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { status: 'failed', current_url: null, expected_url: '', pending_update_count: 0, error: 'TELEGRAM_BOT_TOKEN не задан' };
  }

  const expectedUrl = `${publicWebhookBase()}/api/telegram/webhook`;

  // Без секрета обработчик отказывает каждому обновлению (503, аудит 15.10,
  // P3-03): адрес может быть верным, а бот — молчать. Ответить здесь «ok» по
  // одному адресу значило бы выдать молчащего бота за живого, а ставить вебхук
  // с пустым secret_token — завести адрес, который всё равно ответит отказом.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    const error = 'TELEGRAM_WEBHOOK_SECRET не задан — /api/telegram/webhook отклоняет обновления (503), бот не отвечает';
    await notifyOwner(`<b>Бот Telegram не принимает обновления</b>\n\n${error}. Завести переменную в панели Timeweb.`);
    return { status: 'failed', current_url: null, expected_url: expectedUrl, pending_update_count: 0, error };
  }

  let webhookInfo: { url: string; pending_update_count: number; last_error_date?: unknown; last_error_message?: unknown };
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/getWebhookInfo`);
    const data = await res.json() as { ok: boolean; result: typeof webhookInfo };
    if (!data.ok) {
      return { status: 'failed', current_url: null, expected_url: expectedUrl, pending_update_count: 0, error: 'getWebhookInfo вернул ok=false' };
    }
    webhookInfo = data.result;
  } catch (e) {
    return { status: 'failed', current_url: null, expected_url: expectedUrl, pending_update_count: 0, error: `getWebhookInfo: ${(e as Error).message}` };
  }

  // Ошибка доставки по записи Telegram: секунды Unix и текст о НАШЕМ адресе
  // («Connection timed out», «Wrong response from the webhook: 500»), без ПД.
  const lastErrorAt = typeof webhookInfo.last_error_date === 'number' && Number.isFinite(webhookInfo.last_error_date)
    ? new Date(webhookInfo.last_error_date * 1000).toISOString()
    : null;
  const lastErrorMessage = typeof webhookInfo.last_error_message === 'string' && webhookInfo.last_error_message
    ? webhookInfo.last_error_message.slice(0, 300)
    : null;
  const previous: PreviousDeliveryInput = opts.previous === undefined ? 'unknown' : opts.previous;
  const delivery = judgeDeliveryError({
    lastErrorAt,
    lastErrorMessage,
    pending: webhookInfo.pending_update_count,
    nowMs: opts.nowMs ?? Date.now(),
    previous,
  });
  const deliveryFields = {
    last_error_at: lastErrorAt,
    last_error_message: lastErrorMessage,
    delivery,
    ...(previous === 'unknown' ? { previous_check: 'unknown' as const } : {}),
  };

  const needsRestore =
    webhookInfo.url !== expectedUrl ||
    webhookInfo.pending_update_count > PENDING_UPDATES_THRESHOLD;

  if (!needsRestore) {
    // Адрес верный, а доставка падает: переустановка не поможет, нужен человек.
    let deliveryAlert: 'sent' | 'not_sent' | null = null;
    if (delivery === 'repeating' || delivery === 'stuck') {
      const sent = await notifyOwner(deliveryAlertText({
        verdict: delivery,
        lastErrorAt,
        lastErrorMessage,
        pending: webhookInfo.pending_update_count,
      }));
      deliveryAlert = sent ? 'sent' : 'not_sent';
    }
    return {
      status: 'ok',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
      ...deliveryFields,
      delivery_alert: deliveryAlert,
    };
  }

  // Попытка восстановить
  try {
    const setRes = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: expectedUrl,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: webhookInfo.pending_update_count > PENDING_UPDATES_THRESHOLD,
      }),
    });
    const setData = await setRes.json() as { ok: boolean; description?: string };

    if (setData.ok) {
      return {
        status: 'restored',
        current_url: webhookInfo.url,
        expected_url: expectedUrl,
        pending_update_count: webhookInfo.pending_update_count,
        ...deliveryFields,
        delivery_alert: null,
        action: `Вебхук переустановлен: ${webhookInfo.url} → ${expectedUrl}`,
      };
    }

    // setWebhook не удался — алерт владельцу
    const sent = await notifyOwner(
      `<b>Вебхук Telegram не восстановлен</b>\n\nТекущий: ${escapeHtml(webhookInfo.url || 'пусто')}\nОжидаемый: ${escapeHtml(expectedUrl)}\nОшибка: ${escapeHtml(setData.description ?? 'неизвестно')}`
    );
    return {
      status: 'failed',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
      ...deliveryFields,
      delivery_alert: sent ? 'sent' : 'not_sent',
      error: setData.description ?? 'setWebhook вернул ok=false',
    };
  } catch (e) {
    const sent = await notifyOwner(
      `<b>Вебхук Telegram: исключение при восстановлении</b>\n\n${escapeHtml((e as Error).message)}`
    );
    return {
      status: 'failed',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
      ...deliveryFields,
      delivery_alert: sent ? 'sent' : 'not_sent',
      error: (e as Error).message,
    };
  }
}
