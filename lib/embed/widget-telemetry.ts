/**
 * lib/embed/widget-telemetry.ts — счёт выдач и открытий виджетов партнёров
 * в `widget_daily` (миграция 1282; аудит 15.10, находка WID-measure, W6).
 *
 * Два производителя:
 *  - выдача скрипта формы — GET /api/widget/lead.js, хост из Referer;
 *  - открытие окна — маяк POST /api/widget/event из embed.js и lead.js.
 * Потребитель — перепись GET /api/cron/widget-census.
 *
 * Запись НЕ ждётся вызывающим и ответ не роняет: скрипт на чужом сайте и
 * маяк не должны зависеть от того, записался ли счёт. Но и не молчит —
 * отказ уходит в лог с SQLSTATE (§4.0): «открытий ноль» и «запись падает»
 * обязаны быть различимы.
 *
 * Хост подделывается — это сигнал для счёта, а не замок (см.
 * lib/embed/widget-origin.ts). Боты не считаются: краулер, исполнивший
 * скрипт при обходе страницы, — не посетитель партнёра.
 */
import { isBotUserAgent } from '@/lib/analytics/bot-detect';
import type { WidgetKind } from '@/lib/embed/widget-origin';

export type { WidgetKind };

interface Exec {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>;
}

/**
 * Выдача lead.js: +1 к served формы. $1 — partners.id, $2 — хост или NULL.
 * День — по Камчатке, как у людей, которые смотрят счёт.
 */
export const WIDGET_SERVED_SQL = `
  INSERT INTO widget_daily (partner_id, day, host, widget, served, opened)
  VALUES ($1::uuid, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date, $2::varchar, 'form', 1, 0)
  ON CONFLICT (partner_id, day, host, widget)
  DO UPDATE SET served = widget_daily.served + 1, updated_at = NOW()`;

/**
 * Открытие окна: +1 к opened. $1 — slug партнёра, $2 — хост или NULL,
 * $3 — род виджета. Партнёр ищется тут же, в одном запросе: выключенному
 * виджету счёт не заводится (0 строк — не ошибка, а «не наш партнёр»).
 * served новой строки формы — 0 (сервер её сегодня с этим хостом не выдавал),
 * чата — NULL (выдачу статики сервер не видит).
 */
export const WIDGET_OPENED_SQL = `
  INSERT INTO widget_daily (partner_id, day, host, widget, served, opened)
  SELECT p.id,
         (NOW() AT TIME ZONE 'Asia/Kamchatka')::date,
         $2::varchar,
         $3::varchar,
         CASE WHEN $3::varchar = 'form' THEN 0 END,
         1
    FROM partners p
   WHERE p.slug = $1::varchar AND p.widget_enabled = true
  ON CONFLICT (partner_id, day, host, widget)
  DO UPDATE SET opened = widget_daily.opened + 1, updated_at = NOW()`;

/**
 * Разговор чата виджета в chat_sessions (POST /api/widget/chat). $1 —
 * `widget_<slug>_<id>`, $2 — реплики, $3 — откуда пришёл человек
 * ({host, path, host_check}, lib/embed/widget-origin).
 * Происхождение пишется первым сообщением и дальше не переписывается:
 * разговор пришёл с той страницы, с которой начался.
 *
 * Число реплик человека считает СЕРВЕР: первое сообщение — 1, каждое
 * следующее — +1 к записанному. Прежде его брали из истории, присланной
 * браузером, а окно присылает её урезанной (не больше 20 реплик и 12 000
 * знаков, lib/embed/widget-chat-limits): на 15-й реплике в базу ложилось
 * 11, и перепись widget-census складывала это как замер. Накрутить счёт
 * выдуманной историей тоже было можно (аудит 15.10, R-chat).
 */
export const WIDGET_CHAT_SESSION_SQL = `
  INSERT INTO chat_sessions (session_id, role, messages, user_message_count, is_authenticated, widget_origin, updated_at)
  VALUES ($1, 'tourist', $2::jsonb, 1, false, $3::jsonb, NOW())
  ON CONFLICT (session_id) DO UPDATE
    SET messages = $2::jsonb,
        user_message_count = COALESCE(chat_sessions.user_message_count, 0) + 1,
        widget_origin = COALESCE(chat_sessions.widget_origin, EXCLUDED.widget_origin),
        updated_at = NOW()`;

function logFailure(what: string, err: unknown): void {
  const e = err as { code?: string; message?: string } | null;
  console.error(
    `[widget-telemetry] ${what} не записан:`,
    `SQLSTATE=${e?.code ?? 'нет'}`,
    e?.message ?? String(err),
  );
}

/**
 * Счёт выдачи скрипта формы. Не бросает: отказ — в лог. Возвращает промис,
 * чтобы тест мог дождаться записи; роут его не ждёт (`void`).
 */
export async function recordWidgetServed(
  exec: Exec,
  partnerId: string,
  host: string | null,
  userAgent: string | null,
): Promise<void> {
  if (isBotUserAgent(userAgent)) return;
  try {
    await exec.query(WIDGET_SERVED_SQL, [partnerId, host]);
  } catch (err) {
    logFailure(`счёт выдачи lead.js (партнёр ${partnerId})`, err);
  }
}

/** Счёт открытия окна. Не бросает: отказ — в лог. */
export async function recordWidgetOpened(
  exec: Exec,
  slug: string,
  host: string | null,
  widget: WidgetKind,
): Promise<void> {
  try {
    await exec.query(WIDGET_OPENED_SQL, [slug, host, widget]);
  } catch (err) {
    logFailure(`счёт открытия окна (${widget}, партнёр ${slug})`, err);
  }
}
