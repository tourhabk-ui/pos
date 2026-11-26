/**
 * Предохранители анонимного чата Кузьмича (`/api/ai/chat`), 21.11.
 *
 * Повод — проверка по посту Reddit «I checked my own vibe coded app»: у ключа
 * LLM не было жёсткого потолка, и между владельцем и счётом стояло только то,
 * что никто ещё не посмотрел. У Ведара было так же:
 *  - длина сообщения не ограничивалась вовсе, история — 20 строк любой длины,
 *    фото — до 8 МБ;
 *  - 10 бесплатных сообщений считались на sessionId, а его присылает клиент:
 *    новый id — новые 10;
 *  - `AI_DAILY_BUDGET_USD` только будил тревогу крона, вызовы шли дальше.
 *
 * Здесь три предохранителя, все — до вызова модели:
 *  1. размеры входа (MAX_MESSAGE_CHARS, история, фото) — в схеме роута;
 *  2. бесплатные сообщения гостя — ещё и на IP за сутки (ANON_PER_IP_DAILY);
 *  3. жёсткий суточный стоп гостевых вызовов: траты LLM сайта за сегодня (UTC)
 *     из `llm_usage_log` ≥ дневного бюджета (`AI_DAILY_BUDGET_USD`, без него —
 *     $5, лимит владельца) — гость получает честный ответ без вызова модели.
 *     Расход раннера GitHub в сумму не входит (23.11, `lib/ai/spend-scope.ts`).
 *     Вторая линия — счётчик гостевых ответов процесса за сутки
 *     (`AI_ANON_DAILY_MAX`, по умолчанию 400): работает, даже если книга
 *     трат не прочиталась.
 *
 * Вошедшие пользователи стопом не останавливаются: у них своя ответственность
 * и свои лимиты, а у бюджета — тревога крона llm-budget-check.
 */

import { SPEND_TODAY_SQL, STOP_SPEND_SQL } from '@/lib/ai/spend-scope';

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_HISTORY_ITEMS_USED = 10;
export const MAX_HISTORY_ITEM_CHARS = 2000;
export const MAX_HISTORY_TOTAL_CHARS = 12_000;
/** ≈3 МБ двоичного фото в base64 (4/3 от размера). */
export const MAX_IMAGE_BASE64_CHARS = 4_000_000;
export const MAX_IMAGE_BYTES = 3_000_000;

export const DEFAULT_DAILY_BUDGET_USD = 5;
export const DEFAULT_ANON_DAILY_MAX = 400;
export const ANON_PER_IP_DAILY = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const SPEND_CACHE_MS = 60_000;

export const ANON_DAILY_STOP_TEXT =
  'На сегодня бесплатные ответы Кузьмича для гостей закончились: у Ведара есть дневной лимит расходов на ИИ, и он исчерпан. ' +
  'Войдите в аккаунт — для вошедших чат работает, — или напишите завтра. ' +
  'Туры, маршруты и места на сайте открыты как обычно. Если вы в опасности — звоните 112.';

export const ANON_IP_LIMIT_TEXT =
  'С этого адреса сегодня уже задано много вопросов без входа. Войдите в аккаунт, чтобы продолжить, — это бесплатно. Если вы в опасности — звоните 112.';

export function dailyBudgetUsd(raw: string | undefined = process.env.AI_DAILY_BUDGET_USD): number {
  const n = Number(String(raw ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

export function anonDailyMax(raw: string | undefined = process.env.AI_ANON_DAILY_MAX): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ANON_DAILY_MAX;
}

type HistoryItem = { role: 'user' | 'assistant'; content: string };

/** Последние N строк истории, каждая обрезана, и общий объём под потолком. */
export function trimHistory<T extends HistoryItem>(history: T[] | undefined): T[] {
  if (!history?.length) return [];
  const tail = history.slice(-MAX_HISTORY_ITEMS_USED).map((m) => ({
    ...m,
    content: m.content.length > MAX_HISTORY_ITEM_CHARS ? m.content.slice(0, MAX_HISTORY_ITEM_CHARS) : m.content,
  }));
  const out: T[] = [];
  let total = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    total += tail[i].content.length;
    if (total > MAX_HISTORY_TOTAL_CHARS) break;
    out.unshift(tail[i]);
  }
  return out;
}

export type SpendReader = () => Promise<number>;

export interface AnonGuard {
  /** Можно ли гостю этого IP получить ещё один ответ сегодня (берёт место). */
  takeIpSlot(ip: string): boolean;
  /** Жёсткий суточный стоп: true — гостю модель сегодня не вызываем. */
  dailyStopped(): Promise<boolean>;
  /** Отметить состоявшийся гостевой вызов (вторая линия стопа). */
  countAnonCall(): void;
  /** Только для тестов. */
  reset(): void;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function createAnonGuard(opts: {
  readSpendToday: SpendReader;
  now?: () => number;
  budgetUsd?: () => number;
  dailyMax?: () => number;
  perIpDaily?: number;
}): AnonGuard {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetUsd ?? (() => dailyBudgetUsd());
  const dailyMax = opts.dailyMax ?? (() => anonDailyMax());
  const perIp = opts.perIpDaily ?? ANON_PER_IP_DAILY;

  let day = '';
  let anonCalls = 0;
  const ipCounts = new Map<string, number>();
  let spendCache: { at: number; usd: number } | null = null;

  function rollDay(): void {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      anonCalls = 0;
      ipCounts.clear();
      spendCache = null;
    }
  }

  return {
    takeIpSlot(ip: string): boolean {
      rollDay();
      const used = ipCounts.get(ip) ?? 0;
      if (used >= perIp) return false;
      ipCounts.set(ip, used + 1);
      return true;
    },
    async dailyStopped(): Promise<boolean> {
      rollDay();
      if (anonCalls >= dailyMax()) return true;
      const t = now();
      if (!spendCache || t - spendCache.at > SPEND_CACHE_MS) {
        try {
          spendCache = { at: t, usd: await opts.readSpendToday() };
        } catch {
          // Книга трат не прочиталась — судим по второй линии (счётчик выше),
          // а не открываем шлюз молча и не закрываем его для всех.
          spendCache = { at: t, usd: spendCache?.usd ?? 0 };
        }
      }
      return spendCache.usd >= budget();
    },
    countAnonCall(): void {
      rollDay();
      anonCalls += 1;
    },
    reset(): void {
      day = '';
      anonCalls = 0;
      ipCounts.clear();
      spendCache = null;
    },
  };
}

/**
 * Траты LLM сайта за сегодняшние сутки (UTC) — та же сумма, что крон
 * llm-budget-check сверяет с порогом. Расход раннера GitHub сюда не входит
 * (слово владельца 23.11 «1 да», `lib/ai/spend-scope.ts`).
 */
export async function readLlmSpendToday(): Promise<number> {
  const { pool } = await import('@/lib/db-pool');
  const { rows } = await pool.query<{ spent: string }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS spent
       FROM llm_usage_log
      WHERE ${SPEND_TODAY_SQL}
        AND ${STOP_SPEND_SQL}`,
  );
  return parseFloat(rows[0]?.spent ?? '0') || 0;
}

export const anonChatGuard: AnonGuard = createAnonGuard({ readSpendToday: readLlmSpendToday });

/** Срок окна в мс — для пояснений и тестов. */
export const ANON_WINDOW_MS = DAY_MS;

/* ─── Анонимные двери кроме гостевого чата (26.11) ─────────────────────────
 *
 * Проверка безопасности ИИ-части 26.11 (слово владельца «чини Карт бланш»):
 * у свободного разговора чужого агента по A2A и у чата виджета на сайтах
 * партнёров не было ни дневного предела на адрес, ни своей доли бюджета —
 * только 10–15 вопросов в минуту. Один посетитель за минуты доводил траты до
 * общего суточного стопа, и Кузьмич замолкал для всех: на сайте, в Telegram
 * и MAX.
 *
 * Те же три линии, что у гостя, и ещё одна: эти двери останавливаются на
 * доле бюджета (ANON_DOORS_BUDGET_SHARE), а не на всём. Остаток дня остаётся
 * сайту и мессенджерам, где отвечают людям, а не неизвестному клиенту.
 * Вопрос о беде (sos-detector) двери пропускают мимо пределов — это решает
 * вызывающий, не охрана.
 */

/** Доля суточного бюджета, после которой A2A-разговор и виджет молчат. */
export const ANON_DOORS_BUDGET_SHARE = 0.5;
/** Вопросов текстом с одного адреса за сутки — как у гостя. */
export const A2A_PER_IP_DAILY = ANON_PER_IP_DAILY;
export const WIDGET_PER_IP_DAILY = ANON_PER_IP_DAILY;
export const DEFAULT_A2A_DAILY_MAX = 300;
export const DEFAULT_WIDGET_DAILY_MAX = 400;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function a2aDailyMax(raw: string | undefined = process.env.AI_A2A_DAILY_MAX): number {
  return positiveIntOr(raw, DEFAULT_A2A_DAILY_MAX);
}

export function widgetDailyMax(raw: string | undefined = process.env.AI_WIDGET_DAILY_MAX): number {
  return positiveIntOr(raw, DEFAULT_WIDGET_DAILY_MAX);
}

/** Порог трат для анонимных дверей: доля дневного бюджета. */
export function anonDoorsBudgetUsd(): number {
  return dailyBudgetUsd() * ANON_DOORS_BUDGET_SHARE;
}

export const a2aChatGuard: AnonGuard = createAnonGuard({
  readSpendToday: readLlmSpendToday,
  budgetUsd: anonDoorsBudgetUsd,
  dailyMax: () => a2aDailyMax(),
  perIpDaily: A2A_PER_IP_DAILY,
});

export const widgetChatGuard: AnonGuard = createAnonGuard({
  readSpendToday: readLlmSpendToday,
  budgetUsd: anonDoorsBudgetUsd,
  dailyMax: () => widgetDailyMax(),
  perIpDaily: WIDGET_PER_IP_DAILY,
});
