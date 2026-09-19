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

// ── Уведомление владельцу ────────────────────────────────────────────────────

async function notifyOwner(text: string): Promise<void> {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? '171286547';
  if (!token) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    ownerId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
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

export interface WebhookCheckResult {
  status: 'ok' | 'restored' | 'failed';
  current_url: string | null;
  expected_url: string;
  pending_update_count: number;
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

export async function checkAndRestoreWebhook(): Promise<WebhookCheckResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { status: 'failed', current_url: null, expected_url: '', pending_update_count: 0, error: 'TELEGRAM_BOT_TOKEN не задан' };
  }

  const expectedUrl = `${publicWebhookBase()}/api/telegram/webhook`;

  let webhookInfo: { url: string; pending_update_count: number };
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/getWebhookInfo`);
    const data = await res.json() as { ok: boolean; result: { url: string; pending_update_count: number } };
    if (!data.ok) {
      return { status: 'failed', current_url: null, expected_url: expectedUrl, pending_update_count: 0, error: 'getWebhookInfo вернул ok=false' };
    }
    webhookInfo = data.result;
  } catch (e) {
    return { status: 'failed', current_url: null, expected_url: expectedUrl, pending_update_count: 0, error: `getWebhookInfo: ${(e as Error).message}` };
  }

  const needsRestore =
    webhookInfo.url !== expectedUrl ||
    webhookInfo.pending_update_count > PENDING_UPDATES_THRESHOLD;

  if (!needsRestore) {
    return {
      status: 'ok',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
    };
  }

  // Попытка восстановить
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
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
        action: `Вебхук переустановлен: ${webhookInfo.url} → ${expectedUrl}`,
      };
    }

    // setWebhook не удался — алерт владельцу
    await notifyOwner(
      `<b>Вебхук Telegram не восстановлен</b>\n\nТекущий: ${webhookInfo.url || 'пусто'}\nОжидаемый: ${expectedUrl}\nОшибка: ${setData.description ?? 'неизвестно'}`
    );
    return {
      status: 'failed',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
      error: setData.description ?? 'setWebhook вернул ok=false',
    };
  } catch (e) {
    await notifyOwner(
      `<b>Вебхук Telegram: исключение при восстановлении</b>\n\n${(e as Error).message}`
    );
    return {
      status: 'failed',
      current_url: webhookInfo.url,
      expected_url: expectedUrl,
      pending_update_count: webhookInfo.pending_update_count,
      error: (e as Error).message,
    };
  }
}
