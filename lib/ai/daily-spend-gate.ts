/**
 * Жёсткий стоп дневного бюджета LLM (AI_DAILY_BUDGET_USD, иначе $5).
 *
 * Крон `/api/cron/llm-budget-check` по-прежнему только предупреждает владельца.
 * Этот модуль стоит ПЕРЕД новым вызовом модели: если сумма `llm_usage_log`
 * за сегодняшние сутки (то же окно, что у крона: DATE_TRUNC('day', NOW()))
 * уже не меньше порога, вызова нет. Человеку — короткая честная фраза,
 * без «база ограничена» и без выдуманного сбоя.
 *
 * Чтение суммы кэшируется ненадолго, чтобы не бить БД на каждом ходе.
 * Отказ чтения книги не закрывает шлюз всем: это «не смог проверить»,
 * а не доказанный перерасход.
 */

import { dailyBudgetUsd, readLlmSpendToday, DEFAULT_DAILY_BUDGET_USD } from '@/lib/ai/anon-chat-guard';

/** Сколько держим прочитанную сумму, чтобы не ходить в БД на каждый вызов. */
export const SPEND_CACHE_MS = 15_000;

export const KUZMICH_DAILY_REST_TEXT =
  'Кузьмич на сегодня отдыхает. Заявку можно оставить на сайте — оператор свяжется. Если вы в опасности — звоните 112.';

export class DailyBudgetStopped extends Error {
  readonly code = 'DAILY_LLM_BUDGET_STOPPED' as const;
  constructor() {
    super(KUZMICH_DAILY_REST_TEXT);
    this.name = 'DailyBudgetStopped';
  }
}

export function isDailyBudgetStopped(err: unknown): err is DailyBudgetStopped {
  return err instanceof DailyBudgetStopped
    || (err instanceof Error && (err as { code?: string }).code === 'DAILY_LLM_BUDGET_STOPPED');
}

type Clock = () => number;
type SpendReader = () => Promise<number>;
type BudgetReader = () => number;

let spendCache: { at: number; usd: number } | null = null;
let nowFn: Clock = Date.now;
let readSpend: SpendReader = readLlmSpendToday;
let readBudget: BudgetReader = () => dailyBudgetUsd();

/** Только для юнит-тестов: подменить часы, чтение суммы и порог, сбросить кэш. */
export function configureDailySpendGateForTests(opts: {
  now?: Clock;
  readSpendToday?: SpendReader;
  budgetUsd?: BudgetReader;
} | null): void {
  nowFn = opts?.now ?? Date.now;
  readSpend = opts?.readSpendToday ?? readLlmSpendToday;
  readBudget = opts?.budgetUsd ?? (() => dailyBudgetUsd());
  spendCache = null;
}

export function resetDailySpendGateCache(): void {
  spendCache = null;
}

/**
 * Потрачено за сегодня (USD), с коротким кэшем.
 * При ошибке чтения возвращает последнюю известную сумму или 0.
 */
export async function cachedLlmSpendToday(): Promise<number> {
  const t = nowFn();
  if (spendCache && t - spendCache.at <= SPEND_CACHE_MS) return spendCache.usd;
  try {
    const usd = await readSpend();
    spendCache = { at: t, usd };
    return usd;
  } catch {
    const usd = spendCache?.usd ?? 0;
    spendCache = { at: t, usd };
    return usd;
  }
}

export async function isDailyLlmBudgetStopped(): Promise<boolean> {
  const spent = await cachedLlmSpendToday();
  return spent >= readBudget();
}

/** Бросает DailyBudgetStopped, если новые вызовы LLM сегодня нельзя. */
export async function assertDailyLlmBudget(): Promise<void> {
  if (await isDailyLlmBudgetStopped()) throw new DailyBudgetStopped();
}

export { DEFAULT_DAILY_BUDGET_USD };
