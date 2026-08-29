/**
 * GET /api/cron/evo
 *
 * Evo System — параллельная оркестрация агентов.
 * Growth + Rescue + Evolver Analysis запускаются одновременно.
 * Evolution Loop — последовательно (пишет фиксы в БД).
 *
 * URL: https://vedarai.ru/api/cron/evo?secret=<CRON_SECRET>
 *
 * ── Concurrency-guard (ревью 28.08) ──────────────────────────────────────────
 *
 * До этой правки роут был защищён от параллельного прогона ТОЛЬКО GitHub
 * Actions `concurrency: cron-evo` — а это сериализует прогоны только друг с
 * другом внутри GH Actions, не запрос откуда-то ещё (внешний cron-job.org,
 * ручной workflow_dispatch, запоздавший нативный прогон). Два оркестратора
 * разом — не просто трата денег: Evolution Loop пишет фиксы в БД и может
 * открыть PR, и гонка там опаснее задержки будильника.
 *
 * `pg_try_advisory_lock` — та же техника, что закрывает гонку овербукинга в
 * app/api/accommodations/[id]/book/route.ts (см. README), но НЕ `_xact_`-
 * вариант оттуда: там критическая секция — миллисекунды внутри одной
 * транзакции (COUNT + INSERT), здесь — весь прогон оркестратора (до 120с,
 * внешние LLM/API вызовы). Держать транзакцию открытой 120 секунд ради
 * этого — риск для БД (долгая транзакция блокирует autovacuum на затронутых
 * таблицах). Session-level `pg_try_advisory_lock`/`pg_advisory_unlock` даёт
 * ТУ ЖЕ атомарность на уровне Postgres (проверка и захват — одна операция
 * сервера, не check-then-act двумя запросами) без открытой транзакции:
 * соединение просто держится idle, а не in-transaction, и освобождается в
 * finally независимо от исхода.
 *
 * Первая версия защиты (до ревью) проверяла активную kernel-задачу ДО
 * createTask — check-then-act с окном гонки ровно там, где второй источник
 * (внешний триггер) и должен был появиться. `pg_try_advisory_lock` эту дыру
 * закрывает полностью: два вызова, разошедшиеся на миллисекунды, всё равно
 * получат ровно один true и один false от самого Postgres.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runEvoOrchestrator } from '@/lib/agents/orchestrator';
import { buildEvoAlert } from '@/lib/agents/evo/alert';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { startEvoRunTask, finishEvoRunTask, failEvoRunTask } from '@/lib/agents/kernel/adapters/evo-run-task';

export const dynamic = 'force-dynamic';
// 120 → 300 (29.08): консолидация агентов подняла оркестратор до 10 стадий,
// две из бывших отдельных crona уже объявляли maxDuration=300 у себя
// (industry-intel, memory-reflect), а Scout Digest в реальном прогоне
// занимал ~293с — под старым лимитом весь запрос убивался платформой раньше,
// чем самая медленная параллельная стадия успевала закончиться. Вызывающий
// workflow (cron-evo.yml) уже терпит 300с (--max-time 300, timeout-minutes: 8).
export const maxDuration = 300;

const LOCK_KEY = 'evo.run';

async function tryAcquireEvoRunLock(): Promise<PoolClient | null> {
  const client = await pool.connect();
  const { rows } = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
    [LOCK_KEY],
  );
  if (rows[0]?.locked) return client;
  client.release();
  return null;
}

async function releaseEvoRunLock(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
  } catch (err) {
    // Соединение отдаётся пулу в любом случае; незакрытый advisory-lock на
    // уровне сессии умирает вместе с ней — не молчим, но и не роняем ответ.
    console.error('[cron/evo] advisory-unlock не выполнен:', err instanceof Error ? err.message : err);
  } finally {
    client.release();
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Атомарный захват ДО заведения kernel-задачи: проигравший не создаёт
  // задачу, которую тут же пришлось бы отбрасывать, и не зовёт оркестратор
  // вовсе. Это НЕ ошибка вызывающего — второй живой источник расписания
  // (внешний cron поверх нативного GH Actions) сработает так по построению.
  const lock = await tryAcquireEvoRunLock();
  if (!lock) {
    return NextResponse.json({
      success: true,
      status: 'skipped_already_running',
      run_logged: false,
      kernel_task_id: null,
      trace_id: null,
    });
  }

  const scanType = request.nextUrl.searchParams.get('type') ?? 'full';
  const startedAt = new Date();

  // Kernel-задача прогона: durable identity + стадии событиями. Fail-soft —
  // отказ kernel не роняет крон, но виден: kernel_task_id: null в ответе.
  // Заводится ПОСЛЕ захвата lock — проигравший (см. выше) её не создаёт.
  const kernelHandle = await startEvoRunTask(scanType);

  try {
    const result = await runEvoOrchestrator(scanType);

    if (kernelHandle) await finishEvoRunTask(kernelHandle, result);

    const success = result.errors.length === 0;
    const status = success ? 'completed' : 'partial';

    // Терминальная запись — часть контракта, не fire-and-forget телеметрия:
    // отказ записи виден вызывающему в поле run_logged (P0 аудита 27.08).
    const runLogged = await logAgentRun({
      agent_id: 'evo',
      status: success ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: { status, ...result } as unknown as Record<string, unknown>,
    });

    const alertText = buildEvoAlert(result);
    if (alertText) {
      void tgNotify(alertText);
    }

    // Partial — полезный прогон, поэтому HTTP 200 сохраняем. Но контракт не
    // врёт: workflow обязан увидеть success=false/status=partial и покраснеть.
    return NextResponse.json({
      success,
      status,
      run_logged: runLogged,
      kernel_task_id: kernelHandle?.taskId ?? null,
      trace_id: kernelHandle?.traceId ?? null,
      ...result,
    });
  } catch (err) {
    if (kernelHandle) await failEvoRunTask(kernelHandle, err instanceof Error ? err.message : String(err));
    const runLogged = await logAgentRun({
      agent_id: 'evo',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });

    return NextResponse.json(
      {
        success: false,
        status: 'failed',
        run_logged: runLogged,
        kernel_task_id: kernelHandle?.taskId ?? null,
        trace_id: kernelHandle?.traceId ?? null,
        error: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 },
    );
  } finally {
    await releaseEvoRunLock(lock);
  }
}

async function tgNotify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { /* silent */ }
}
