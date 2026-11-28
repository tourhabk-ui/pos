/**
 * GET /api/cron/llm-budget-check
 * Считает дневные LLM-затраты из llm_usage_log.
 * Если расход сайта достиг AI_DAILY_BUDGET_USD — отправляет Telegram-алерт
 * владельцу. Расход раннера GitHub с порогом не сверяется: стоп его не
 * считает (слово владельца 23.11), он назван отдельной строкой.
 * Запускать ежечасно или реже.
 *
 * Порог не задан или не число — прогон НЕ успех (lib/ai/daily-budget.ts): траты
 * дня всё равно считаются и отдаются в ответе, а в журнал уходит отказ с
 * причиной, и Watchdog говорит владельцу, что бюджет не сторожится.
 */

import { pool } from '@/lib/db-pool';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { notifyBudgetAlert } from '@/lib/telegram/admin-notify';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { readDailyBudget, BUDGET_UNSET_REASON, BUDGET_INVALID_REASON, llmBudgetKernelEnabled } from '@/lib/ai/daily-budget';
import { recordBudgetStop, ensureBudgetAlert } from '@/lib/agents/kernel/llm-budget';
import { STOP_SPEND_SQL, RUNNER_SPEND_SQL, SPEND_TODAY_SQL } from '@/lib/ai/spend-scope';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  // Два планировщика (GitHub и супервизор контейнера, start.js): аренда окна в
  // час не даёт им прислать один и тот же алерт о превышении дважды. Ключ —
  // agentId записи реестра, под ним же пишется heartbeat.
  const lease = await claimCronWindow('llm-budget', 60, 'external');
  if (!shouldRun(lease)) return Response.json(leaseSkipBody('llm-budget', 60));

  const startedAt = Date.now();

  const budget = readDailyBudget(process.env.AI_DAILY_BUDGET_USD);

  // Heartbeat пишется ПОСЛЕ проверки, по её исходу. Раньше success уходил
  // до запроса к БД, а сам запрос стоял без catch: упавшая БД давала
  // не-JSON 500 и при этом «живой успешный» крон в реестре — проверка,
  // которая не смогла выполниться, отчитывалась хорошей.
  try {
    // #1862: estimated_cost_usd теперь может быть NULL («цену не знаем»,
    // миграция 961) — а SUM(...) молча пропускает NULL, считая её нулём.
    // Бюджет по КАЛЬКУЛИРУЕМЫМ строкам остаётся точным; строки с неизвестной
    // ценой не должны пропадать из ответа — иначе «потрачено X» читалось бы
    // как факт там, где часть трат не посчитана вовсе.
    //
    // С порогом сверяется та же сумма, что считает стоп, — расход сайта
    // (слово владельца 23.11 «1 да», lib/ai/spend-scope.ts). Расход раннера
    // GitHub стоп не закрывает; его сумма идёт отдельной строкой ответа и
    // тревоги, чтобы трата не пропала из виду.
    const { rows } = await pool.query<{ spent: string; runner_spent: string; unknown_calls: string }>(`
      SELECT
        COALESCE(SUM(estimated_cost_usd) FILTER (WHERE ${STOP_SPEND_SQL}), 0)::text AS spent,
        COALESCE(SUM(estimated_cost_usd) FILTER (WHERE ${RUNNER_SPEND_SQL}), 0)::text AS runner_spent,
        COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND ${STOP_SPEND_SQL})::text AS unknown_calls
      FROM llm_usage_log
      WHERE ${SPEND_TODAY_SQL}
    `);

    const spentUsd = parseFloat(rows[0]?.spent ?? '0');
    const runnerSpentUsd = parseFloat(rows[0]?.runner_spent ?? '0') || 0;
    const unknownCalls = parseInt(rows[0]?.unknown_calls ?? '0', 10);
    if (unknownCalls > 0) {
      // Не ошибка крона — честная третья форма: посчитано по известному,
      // а часть вызовов сегодня прошла без цены (нет в каталоге и в запасе).
      console.error(`[llm-budget-check] ${unknownCalls} вызовов сегодня без цены — spent_usd занижен на их долю`);
    }

    // Нечем судить — не «успех» (аудит 22.10). Было: `ok: true, skipped` и
    // успех в журнале; тревога о перерасходе молчала при любой трате, а
    // workflow и панель кронов стояли зелёными. Траты дня при этом
    // посчитаны — их видно в ответе, даже пока порога нет.
    if (budget.kind !== 'set') {
      const reason = budget.kind === 'unset' ? BUDGET_UNSET_REASON : BUDGET_INVALID_REASON;
      recordCronRun('llm-budget', startedAt, 'failed', { error: reason });
      return Response.json({
        ok: false,
        status: 'not_configured',
        reason,
        spent_usd: spentUsd,
        runner_spent_usd: runnerSpentUsd,
        unknown_cost_calls: unknownCalls,
      });
    }
    const limitUsd = budget.usd;
    // Мера (перепись пользы агентов, 05.11): одна сверка трат дня с порогом.
    recordCronRun('llm-budget', startedAt, 'success', { items: 1 });

    if (spentUsd >= limitUsd) {
      // Находка аудита 15.10 (P4-01): алерт уходил fire-and-forget, а ответ
      // говорил `alert_sent` при любом исходе — превышение бюджета
      // «срабатывало» только в JSON. «Отправлен» теперь пишется лишь по
      // ответу Telegram; недоставка — свой статус и причина.
      //
      // С 29.11 (PR 1a серии «ядро») закрытие стопа — факт в ядре, и алерт
      // уходит один раз за сутки: аренда окна — час, без дедупа владелец
      // получал одно и то же каждый час. Выключатель LLM_BUDGET_KERNEL=off
      // возвращает прежнее поведение. Троттлинг ядра крону не помеха: у него
      // своя аренда, а taskId приходит и из существующей задачи суток.
      if (!llmBudgetKernelEnabled()) {
        const alert = await notifyBudgetAlert(spentUsd, limitUsd, runnerSpentUsd);
        return Response.json({
          ok: true,
          status: alert.ok ? 'alert_sent' : 'alert_not_delivered',
          alert,
          spent_usd: spentUsd,
          runner_spent_usd: runnerSpentUsd,
          limit_usd: limitUsd,
          unknown_cost_calls: unknownCalls,
        });
      }
      const stop = await recordBudgetStop({ limitUsd, trigger: 'cron' });
      const alert = await ensureBudgetAlert({ taskId: stop.taskId, spentUsd, limitUsd, runnerSpentUsd, mode: 'cron' });
      return Response.json({
        ok: true,
        status: alert.status === 'already_sent'
          ? 'alert_already_sent_today'
          : alert.status === 'sent' ? 'alert_sent' : 'alert_not_delivered',
        // Поле alert читают (tests/unit/tg-delivery-debt.test.ts): прежнее
        // `ok` остаётся — true, если алерт за сутки доставлен (сейчас или
        // раньше), — и рядом исход журнала ядра.
        alert: { ok: alert.status === 'sent' || alert.status === 'already_sent', ...alert },
        spent_usd: spentUsd,
        runner_spent_usd: runnerSpentUsd,
        limit_usd: limitUsd,
        unknown_cost_calls: unknownCalls,
      });
    }

    return Response.json({
      ok: true,
      status: 'ok',
      spent_usd: spentUsd,
      runner_spent_usd: runnerSpentUsd,
      limit_usd: limitUsd,
      unknown_cost_calls: unknownCalls,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка запроса к llm_usage_log';
    console.error('[llm-budget-check] проверка не выполнена:', message);
    recordCronRun('llm-budget', startedAt, 'failed', { error: message });
    return Response.json({ ok: false, status: 'error', error: message }, { status: 502 });
  }
}
