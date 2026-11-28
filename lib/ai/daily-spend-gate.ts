/**
 * Жёсткий стоп дневного бюджета LLM (AI_DAILY_BUDGET_USD, иначе $5).
 *
 * Крон `/api/cron/llm-budget-check` по-прежнему только предупреждает владельца.
 * Этот модуль стоит ПЕРЕД новым вызовом модели: если сумма `llm_usage_log`
 * за сегодняшние сутки (то же окно, что у крона: DATE_TRUNC('day', NOW()))
 * уже не меньше порога, вызова нет. Считается только расход сайта: строки
 * раннера GitHub в сумму не входят (слово владельца 23.11 «1 да»,
 * `lib/ai/spend-scope.ts`). Человеку — короткая честная фраза,
 * без «база ограничена» и без выдуманного сбоя.
 *
 * Чтение суммы кэшируется ненадолго, чтобы не бить БД на каждом ходе.
 * Отказ чтения книги не закрывает шлюз всем: это «не смог проверить»,
 * а не доказанный перерасход.
 */

import { dailyBudgetUsd, readLlmSpendToday, DEFAULT_DAILY_BUDGET_USD } from '@/lib/ai/anon-chat-guard';
import { llmBudgetKernelEnabled } from '@/lib/ai/daily-budget';

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

/**
 * Сумма, порог и закрыт ли стоп — одним снимком: ядро
 * (`lib/agents/kernel/llm-budget.ts`) берёт порог отсюда, поэтому подмена
 * `configureDailySpendGateForTests` действует и на него.
 */
export async function readDailyBudgetSnapshot(): Promise<{ spentUsd: number; limitUsd: number; stopped: boolean }> {
  const spentUsd = await cachedLlmSpendToday();
  const limitUsd = readBudget();
  return { spentUsd, limitUsd, stopped: spentUsd >= limitUsd };
}

/**
 * Закрытие стопа — фактом в ядро и одним алертом владельцу за сутки (PR 1a
 * серии «ядро», 29.11). Не ждётся и не меняет ни ответ, ни задержку вызова:
 * запись и отправка идут после возврата результата, ошибка только в лог.
 * Ядро импортируется динамически: lib/ai не тянет lib/agents/kernel в свой
 * граф (кольцо и реестр возможностей кронов). Частоту держит само ядро:
 * троттлинг 10 минут и одна попытка на процесс одновременно.
 */
function recordStopInKernel(limitUsd: number): void {
  void import('@/lib/agents/kernel/llm-budget')
    .then(async (m) => {
      const r = await m.recordBudgetStop({ limitUsd, trigger: 'gate' });
      // Не только при first: задача суток уже есть, а алерт ещё не доставлен
      // (Telegram не ответил, крон молчит в not_configured) — повтор отсюда.
      if (!r.throttled && r.taskId && r.spentUsd !== null) {
        await m.ensureBudgetAlert({ taskId: r.taskId, spentUsd: r.spentUsd, limitUsd, runnerSpentUsd: null, mode: 'gate' });
      }
    })
    .catch((err: unknown) => {
      console.error('[daily-spend-gate] закрытие стопа не записано в ядро:', err instanceof Error ? err.message : String(err));
    });
}

export async function isDailyLlmBudgetStopped(): Promise<boolean> {
  const snap = await readDailyBudgetSnapshot();
  if (snap.stopped && llmBudgetKernelEnabled()) recordStopInKernel(snap.limitUsd);
  return snap.stopped;
}

/** Бросает DailyBudgetStopped, если новые вызовы LLM сегодня нельзя. */
export async function assertDailyLlmBudget(): Promise<void> {
  if (await isDailyLlmBudgetStopped()) throw new DailyBudgetStopped();
}

export { DEFAULT_DAILY_BUDGET_USD };
