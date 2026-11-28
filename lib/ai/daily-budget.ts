/**
 * Порог дневного бюджета AI — с исходом «не задан» (§4.0).
 *
 * Крон `/api/cron/llm-budget-check` без `AI_DAILY_BUDGET_USD` отвечал
 * `ok: true, status: 'skipped'` и писал в журнал прогонов «успех». Workflow
 * зеленел каждый час, панель кронов была зелёной, а тревога о перерасходе не
 * могла сработать ни при какой трате — переменная на проде не задана (аудит
 * перед запуском, 22.10). Проверка, которой нечем судить, отчитывалась хорошей.
 *
 * Теперь у порога три исхода, и «не задан» и «не число» — не успех: крон
 * пишет отказ с причиной, и сторож кронов Watchdog говорит о нём владельцу
 * (`cron_failing`, дебаунс 12 ч по тексту причины — поэтому причина
 * постоянная, без суммы трат).
 */

export type DailyBudget =
  | { kind: 'set'; usd: number }
  | { kind: 'unset' }
  | { kind: 'invalid' };

/** Причины — постоянным текстом: по нему Watchdog узнаёт повтор. */
export const BUDGET_UNSET_REASON =
  'AI_DAILY_BUDGET_USD не задан в переменных приложения — дневной бюджет AI не сторожится';
export const BUDGET_INVALID_REASON =
  'AI_DAILY_BUDGET_USD задан, но это не число больше нуля — дневной бюджет AI не сторожится';

export function readDailyBudget(raw: string | undefined): DailyBudget {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'unset' };
  // Number, а не parseFloat: «10abc» — опечатка, а не десять долларов.
  const usd = Number(text.replace(',', '.'));
  if (!Number.isFinite(usd) || usd <= 0) return { kind: 'invalid' };
  return { kind: 'set', usd };
}

/**
 * Выключатель записи суточного стопа в ядро Volcano OS (`LLM_BUDGET_KERNEL`).
 *
 * `off` (без учёта регистра и пробелов) выключает НОВОЕ поведение: запись
 * факта закрытия стопа в ядро и суточный дедуп алерта. Сам стоп
 * (`lib/ai/daily-spend-gate.ts`, `AI_DAILY_BUDGET_USD`, без неё $5) и часовой
 * алерт крона этим не выключаются. Не задана или любое иное значение —
 * включено. Единственное место, где читается переменная: сторож
 * tests/unit/kernel-llm-budget.test.ts держит, что больше её не читает никто.
 */
export function llmBudgetKernelEnabled(raw: string | undefined = process.env.LLM_BUDGET_KERNEL): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'off';
}
