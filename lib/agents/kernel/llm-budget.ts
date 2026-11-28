/**
 * Ядро видит закрытие суточного стопа LLM и один раз за сутки говорит
 * владельцу (PR 1a серии «ядро», задание 29.11, правило владельца: траты LLM
 * сайта не больше $5 в сутки).
 *
 * Сам стоп живёт в `lib/ai/daily-spend-gate.ts` и здесь не меняется: сумма
 * `llm_usage_log` за сутки против `AI_DAILY_BUDGET_USD` (без неё $5). Модуль
 * только записывает ФАКТ закрытия:
 *  - задача `llm.budget_stop` на сутки с событием `policy_denied` (ключ
 *    идемпотентности `llm-budget-stop:<YYYY-MM-DD>`, дедуп атомарен в БД);
 *  - один Telegram-алерт за сутки: «доставлено» — событие `note
 *    {alert:'delivered'}` на задаче суток, источник правды — журнал, не
 *    память процесса.
 *
 * Память процесса держит только частоту: троттлинг 10 минут и одна попытка
 * одновременно (single-flight). Без неё партия крона, упёршаяся в закрытый
 * стоп, за микросекунды запустила бы десяток записей в общий с туристами пул.
 * Гонка двух процессов (крон и стоп одновременно) может дать два алерта — это
 * принято и названо в PR.
 *
 * Выключатель — `LLM_BUDGET_KERNEL=off` (`llmBudgetKernelEnabled`). Функции
 * не бросают: ошибка — в лог с причиной.
 */

import { pool } from '@/lib/db-pool';
import { llmBudgetKernelEnabled } from '@/lib/ai/daily-budget';
import { readLlmSpendWithDayKey } from '@/lib/ai/anon-chat-guard';
import { appendEvent, claimTaskById, createTask, transition } from './kernel';

export const LLM_BUDGET_CAPABILITY = 'llm.budget_stop';
const PRINCIPAL = 'system:llm-budget';
const ACTOR = 'kernel';

/** Сколько процесс не повторяет запись стопа после попытки. */
export const BUDGET_STOP_THROTTLE_MS = 600_000;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Причина отказа: человеку и в событие policy_denied. */
export function LLM_BUDGET_DENY_REASON(spentUsd: number, limitUsd: number): string {
  return `дневной бюджет LLM сайта исчерпан (потрачено $${spentUsd.toFixed(2)} из $${limitUsd.toFixed(2)}); `
    + 'действие, которое тратит ИИ, отклонено до 00:00 UTC. Лимит — AI_DAILY_BUDGET_USD';
}

export interface BudgetStopResult {
  /** Задача суток создана этим вызовом. */
  first: boolean;
  /** Ответ из памяти процесса (троттлинг или чужая идущая попытка), БД не читалась. */
  throttled: boolean;
  taskId: string | null;
  spentUsd: number | null;
  dayKey: string | null;
}

const NOTHING: BudgetStopResult = { first: false, throttled: false, taskId: null, spentUsd: null, dayKey: null };

let lastAttempt: { at: number; result: BudgetStopResult } | null = null;
/**
 * Идущая попытка записи. Ключ суток до чтения суммы неизвестен, поэтому
 * попытка одна на процесс — та самая «общая запись pending» из задания.
 */
let inFlight: Promise<BudgetStopResult> | null = null;
/** Идущая отправка алерта — по задаче суток. */
const alertInFlight = new Map<string, Promise<BudgetAlertResult>>();

/** Только для юнит-тестов: сбросить троттлинг и идущие попытки. */
export function resetBudgetStopThrottleForTests(): void {
  lastAttempt = null;
  inFlight = null;
  alertInFlight.clear();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Записать факт закрытия стопа за сутки. Порядок (уточнение ревью 5): сначала
 * идущая попытка — ждём её и отдаём её результат с её taskId; потом
 * троттлинг; потом свежая сумма и ключ суток одним SQL.
 */
export async function recordBudgetStop(info: { limitUsd: number; trigger: 'gate' | 'cron' }): Promise<BudgetStopResult> {
  if (!llmBudgetKernelEnabled()) return { ...NOTHING };
  if (inFlight) {
    const r = await inFlight;
    return { ...r, first: false, throttled: true };
  }
  if (lastAttempt && Date.now() - lastAttempt.at < BUDGET_STOP_THROTTLE_MS) {
    return { ...lastAttempt.result, first: false, throttled: true };
  }
  // Метка — в НАЧАЛЕ попытки: упавшая попытка держит окно так же, как удачная.
  const attempt = { at: Date.now(), result: { ...NOTHING } };
  lastAttempt = attempt;
  const p = runRecord(info, attempt);
  inFlight = p;
  try {
    return await p;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

async function runRecord(
  info: { limitUsd: number; trigger: 'gate' | 'cron' },
  attempt: { at: number; result: BudgetStopResult },
): Promise<BudgetStopResult> {
  try {
    const { spentUsd, dayKey } = await readLlmSpendWithDayKey();
    if (typeof dayKey !== 'string' || !DAY_KEY_RE.test(dayKey)) {
      console.error('[kernel/llm-budget] ключ суток не прочитан — запись стопа отложена на 10 минут');
      return { ...NOTHING };
    }
    if (!(spentUsd >= info.limitUsd)) {
      // Кэш стопа отстал (например, на границе суток): стоп ложный. Это не
      // отказ записи — окно троттлинга не держим.
      if (lastAttempt === attempt) lastAttempt = null;
      return { ...NOTHING, spentUsd, dayKey };
    }
    const outcome = await createTask({
      principal: PRINCIPAL,
      capability: LLM_BUDGET_CAPABILITY,
      risk: 'safe',
      state: 'queued',
      resource: { type: 'llm_budget', id: dayKey },
      idempotencyKey: `llm-budget-stop:${dayKey}`,
    });
    if (!outcome.created) {
      const result: BudgetStopResult = { first: false, throttled: false, taskId: outcome.existing.id, spentUsd, dayKey };
      attempt.result = result;
      return result;
    }
    const taskId = outcome.task.id;
    await closeStopTask(taskId, spentUsd, info);
    const result: BudgetStopResult = { first: true, throttled: false, taskId, spentUsd, dayKey };
    attempt.result = result;
    return result;
  } catch (err) {
    console.error('[kernel/llm-budget] закрытие стопа не записано:', errText(err));
    return { ...NOTHING };
  }
}

/**
 * Захват, событие policy_denied и succeeded. Если событие не записалось,
 * задача всё равно уходит в succeeded с пометкой (уточнение ревью 5): ключ
 * суток остаётся занятым, второго алерта за сутки нет, жнецу нечего брать.
 */
async function closeStopTask(taskId: string, spentUsd: number, info: { limitUsd: number; trigger: 'gate' | 'cron' }): Promise<void> {
  let claimed = false;
  try {
    claimed = (await claimTaskById(taskId, PRINCIPAL)) !== null;
  } catch (err) {
    console.error('[kernel/llm-budget] задача стопа не захвачена:', errText(err));
  }
  if (!claimed) {
    // В queued ключ суток тоже занят — второго алерта не будет.
    console.error('[kernel/llm-budget] задача стопа осталась в queued: захват не удался');
    return;
  }
  let eventError: string | null = null;
  try {
    const ev = await appendEvent(taskId, ACTOR, 'policy_denied', {
      reason: LLM_BUDGET_DENY_REASON(spentUsd, info.limitUsd),
      phase: 'admission',
      spent_usd: spentUsd,
      limit_usd: info.limitUsd,
      trigger: info.trigger,
    });
    if (!ev.ok) eventError = ev.reason ?? 'причина не названа';
  } catch (err) {
    eventError = errText(err);
  }
  if (eventError) console.error('[kernel/llm-budget] событие policy_denied не записано:', eventError);
  const base = `стоп расходов LLM закрыт: потрачено $${spentUsd.toFixed(2)} из $${info.limitUsd.toFixed(2)}`;
  try {
    const tr = await transition(taskId, 'running', 'succeeded', ACTOR, {
      summary: eventError ? `${base} (событие policy_denied не записано: ${eventError})` : base,
      ...(eventError ? { event_write_error: eventError } : {}),
    });
    if (!tr.ok) console.error('[kernel/llm-budget] задача стопа не закрыта:', tr.reason ?? 'причина не названа');
  } catch (err) {
    console.error('[kernel/llm-budget] задача стопа не закрыта:', errText(err));
  }
}

export interface BudgetAlertResult {
  status: 'sent' | 'not_delivered' | 'already_sent' | 'skipped' | 'disabled';
  reason?: string;
}

interface AlertInfo {
  taskId: string | null;
  spentUsd: number;
  limitUsd: number;
  runnerSpentUsd: number | null;
  mode: 'gate' | 'cron';
}

/** Прямая отправка, как крон на main (`notifyBudgetAlert`): без журнала. */
async function sendAlert(info: AlertInfo): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { notifyBudgetAlert } = await import('@/lib/telegram/admin-notify');
    return await notifyBudgetAlert(info.spentUsd, info.limitUsd, info.runnerSpentUsd);
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

async function sendDirect(info: AlertInfo): Promise<BudgetAlertResult> {
  const out = await sendAlert(info);
  return out.ok ? { status: 'sent' } : { status: 'not_delivered', reason: out.reason };
}

/**
 * Один алерт владельцу за сутки. Путь стопа (`gate`) без журнала не шлёт —
 * подхватит крон; путь крона без журнала шлёт напрямую, как сегодня: алерт
 * при недоступном журнале не дедуплицируется, но и не пропадает.
 */
export async function ensureBudgetAlert(info: AlertInfo): Promise<BudgetAlertResult> {
  if (!llmBudgetKernelEnabled()) return { status: 'disabled' };
  if (info.taskId === null) return info.mode === 'cron' ? sendDirect(info) : { status: 'skipped' };
  const key = info.taskId;
  const pending = alertInFlight.get(key);
  if (pending) {
    const r = await pending;
    // Крон ждал путь стопа, а у того не прочитался журнал: крон шлёт сам,
    // как на main (уточнение ревью 5).
    if (info.mode === 'cron' && r.status === 'skipped') return sendDirect(info);
    return r;
  }
  const p = runAlert(info, key);
  alertInFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (alertInFlight.get(key) === p) alertInFlight.delete(key);
  }
}

async function runAlert(info: AlertInfo, taskId: string): Promise<BudgetAlertResult> {
  let delivered: boolean;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM agent_events
        WHERE task_id = $1 AND event_type = 'note' AND details->>'alert' = 'delivered'
        LIMIT 1`,
      [taskId],
    );
    delivered = rows.length > 0;
  } catch (err) {
    console.error('[kernel/llm-budget] журнал алерта не прочитан:', errText(err));
    return info.mode === 'cron' ? sendDirect(info) : { status: 'skipped', reason: 'журнал алерта не прочитан' };
  }
  if (delivered) return { status: 'already_sent' };
  const out = await sendAlert(info);
  const note = out.ok ? { alert: 'delivered' } : { alert: 'not_delivered', reason: out.reason };
  try {
    const ev = await appendEvent(taskId, ACTOR, 'note', note);
    if (!ev.ok) console.error('[kernel/llm-budget] отметка алерта не записана:', ev.reason ?? 'причина не названа');
  } catch (err) {
    console.error('[kernel/llm-budget] отметка алерта не записана:', errText(err));
  }
  return out.ok ? { status: 'sent' } : { status: 'not_delivered', reason: out.reason };
}
