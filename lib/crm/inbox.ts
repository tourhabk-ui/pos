/**
 * lib/crm/inbox.ts — «Входящие» партнёра (CRM #2325, шаг 1г): что ждёт ответа
 * и как быстро партнёр отвечает.
 *
 * Ящик вычисляется из источников (`lib/crm/inbox-sql.ts`), своей таблицы нет.
 * Каждый вид читается своим запросом и отказывает сам по себе: не прочиталась
 * бронь жилья — экран говорит «брони не прочитались», а не «всё отвечено»
 * (§4.0). Медиана, посчитанная при отказавшем виде, помечена неполной.
 *
 * Время первого ответа — медиана по просьбам клиента за 7 дней, на которые
 * был ответ. Меньше пяти ответов — «мало данных», а не число: медиана трёх
 * случаев врёт увереннее, чем молчит.
 */
import { pool } from '@/lib/db-pool';
import { chatService } from '@/lib/services/operators/chat.service';
import type { PartnerCategory } from '@/lib/crm/partner-context';
import { INBOX_SQL } from '@/lib/crm/inbox-sql';
import {
  INBOX_BY_CATEGORY, INBOX_CHAT_CATEGORIES, INBOX_NOT_HERE, RESPONSE_METRIC_KINDS,
  RESPONSE_MIN_SAMPLE, RESPONSE_WINDOW_DAYS, REVIEW_WINDOW_DAYS, type InboxKind,
} from '@/lib/crm/inbox-kinds';

interface Queryable {
  query: typeof pool.query;
}

interface InboxRow {
  item_id: string;
  created_at: Date | string;
  title: string | null;
  item_date: string | null;
  people: number | null;
  waiting: boolean;
  responded_at: Date | string | null;
  contact_id: string | null;
  contact_name: string | null;
}

export interface InboxItem {
  kind: InboxKind;
  id: string;
  created_at: string;
  title: string | null;
  /** Дата поездки / заезда / желаемые даты текстом — как в источнике. */
  date: string | null;
  people: number | null;
  contact_id: string | null;
  contact_name: string | null;
  waiting_minutes: number;
}

export interface ResponseStats {
  window_days: number;
  /** Медиана в минутах; null — ответов меньше порога. */
  median_minutes: number | null;
  /** Сколько просьб окна получили ответ. */
  responded: number;
  enough: boolean;
  /** false — какой-то вид не прочитался, и медиана посчитана не по всем. */
  complete: boolean;
}

export type ChatState = { state: 'none' } | { state: 'ok'; unread: number } | { state: 'failed' };

export interface Inbox {
  category: PartnerCategory;
  items: InboxItem[];
  /** Виды, которые не прочитались: их предметов в списке может не хватать. */
  failed: InboxKind[];
  response: ResponseStats;
  chat: ChatState;
  not_here: readonly string[];
}

function ms(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/** Медиана: нечётное — середина, чётное — среднее двух средних. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Время первого ответа по строкам источников. В счёт идут просьбы клиента
 * (`RESPONSE_METRIC_KINDS`), созданные в окне и получившие ответ. Ответ
 * «раньше создания» (часы разошлись) считается нулём, а не отрицательным.
 */
export function responseStats(
  rows: Array<{ kind: InboxKind; created_at: Date | string; responded_at: Date | string | null }>,
  windowStartMs: number,
  complete: boolean,
): ResponseStats {
  const minutes: number[] = [];
  for (const r of rows) {
    if (!RESPONSE_METRIC_KINDS.has(r.kind) || r.responded_at === null) continue;
    const created = ms(r.created_at);
    if (!(created >= windowStartMs)) continue;
    minutes.push(Math.max(0, (ms(r.responded_at) - created) / 60_000));
  }
  const enough = minutes.length >= RESPONSE_MIN_SAMPLE;
  const m = enough ? median(minutes) : null;
  return {
    window_days: RESPONSE_WINDOW_DAYS,
    median_minutes: m === null ? null : Math.round(m),
    responded: minutes.length,
    enough,
    complete,
  };
}

/** Параметры вида: $3 (окно отзывов) есть только у запроса отзывов. */
function paramsFor(kind: InboxKind, partnerId: string, windowStart: Date, reviewStart: Date): unknown[] {
  return INBOX_SQL[kind].includes('$3') ? [partnerId, windowStart, reviewStart] : [partnerId, windowStart];
}

/**
 * `userId` — аккаунт партнёра: по нему считается непрочитанное в чате
 * платформы. NULL — у партнёрской записи нет аккаунта (Кузьмич в чате знает
 * партнёра по привязанному чату), и чата платформы у неё нет вовсе.
 */
export async function loadInbox(
  partnerId: string,
  category: PartnerCategory,
  userId: string | null,
  opts: { db?: Queryable; nowMs?: number; unreadChat?: (userId: string) => Promise<number> } = {},
): Promise<Inbox> {
  const db = opts.db ?? pool;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = new Date(nowMs - RESPONSE_WINDOW_DAYS * 86_400_000);
  const reviewStart = new Date(nowMs - REVIEW_WINDOW_DAYS * 86_400_000);
  const kinds = INBOX_BY_CATEGORY[category];

  const settled = await Promise.allSettled(
    kinds.map((kind) => db.query<InboxRow>(INBOX_SQL[kind], paramsFor(kind, partnerId, windowStart, reviewStart))),
  );

  const failed: InboxKind[] = [];
  const rows: Array<InboxRow & { kind: InboxKind }> = [];
  settled.forEach((r, i) => {
    const kind = kinds[i];
    if (r.status === 'fulfilled') {
      for (const row of r.value.rows) rows.push({ ...row, kind });
    } else {
      // Отказ вида не глушится и не превращается в «пусто» (§4.0).
      const code = (r.reason as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error(`[crm-inbox] ${kind} не прочитан, SQLSTATE`, code);
      failed.push(kind);
    }
  });

  const items: InboxItem[] = rows
    .filter((r) => r.waiting)
    .map((r) => ({
      kind: r.kind,
      id: r.item_id,
      created_at: new Date(ms(r.created_at)).toISOString(),
      title: r.title,
      date: r.item_date,
      people: r.people,
      contact_id: r.contact_id,
      contact_name: r.contact_name,
      waiting_minutes: Math.max(0, Math.round((nowMs - ms(r.created_at)) / 60_000)),
    }))
    // Дольше всех ждёт — первым.
    .sort((a, b) => b.waiting_minutes - a.waiting_minutes || a.id.localeCompare(b.id));

  const metricFailed = failed.some((k) => RESPONSE_METRIC_KINDS.has(k));

  let chat: ChatState = { state: 'none' };
  if (INBOX_CHAT_CATEGORIES.has(category) && userId !== null) {
    try {
      const unread = await (opts.unreadChat ?? ((u: string) => chatService.getTotalUnread(u)))(userId);
      chat = { state: 'ok', unread };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error('[crm-inbox] непрочитанное в чате не посчитано, SQLSTATE', code);
      chat = { state: 'failed' };
    }
  }

  return {
    category,
    items,
    failed,
    response: responseStats(rows, windowStart.getTime(), !metricFailed),
    chat,
    not_here: INBOX_NOT_HERE[category],
  };
}
