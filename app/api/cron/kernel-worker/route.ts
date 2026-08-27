/**
 * GET /api/cron/kernel-worker
 *
 * Volcano OS — worker очереди ядра (вариант B задания 27.08: GitHub
 * Actions — только будильник, каноническое состояние и конкуренцию держит
 * PostgreSQL Kernel).
 *
 * Каждый прогон: sweep одобренных человеком инициатив в очередь ядра
 * (идемпотентно по ключу initiative:<id>) → дренаж очереди: захват через
 * FOR UPDATE SKIP LOCKED (два worker'а не возьмут одну задачу), сверка
 * payload по input_hash, pre_commit policy, эффект вне DB-транзакций,
 * независимое завершение каждого item.
 *
 * Честный контракт (как у /api/cron/evo): completed — всё исполненное
 * успешно; partial — часть items провалилась (HTTP 200, workflow краснеет
 * по телу); failed — сам worker упал. force-режимов и повышения класса
 * риска через query-параметры НЕТ по построению.
 *
 * URL: https://vedarai.ru/api/cron/kernel-worker?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';
import {
  drainInitiativeQueue,
  sweepApprovedInitiatives,
} from '@/lib/agents/kernel/adapters/initiative-tasks';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BATCH_LIMIT = 10;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = new Date();

  try {
    const sweep = await sweepApprovedInitiatives({ type: 'cron', id: 'kernel-worker' });
    const items = await drainInitiativeQueue(BATCH_LIMIT);

    const failedItems = items.filter((i) => !i.ok);
    const status = failedItems.length === 0 ? 'completed' : 'partial';
    const success = status === 'completed';

    const runLogged = await logAgentRun({
      agent_id: 'kernel_worker',
      status: success ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      items_processed: items.length,
      errors_count: failedItems.length,
      metadata: {
        swept: sweep.scanned,
        enqueued: sweep.outcomes.filter((o) => o.outcome === 'enqueued').length,
        rejected: sweep.outcomes.filter((o) => o.outcome === 'rejected').length,
        task_ids: items.map((i) => i.taskId),
      },
    });

    return NextResponse.json({
      success,
      status,
      run_logged: runLogged,
      swept: sweep.scanned,
      enqueue_outcomes: sweep.outcomes,
      executed: items.filter((i) => i.ok).length,
      failed: failedItems.length,
      items,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const runLogged = await logAgentRun({
      agent_id: 'kernel_worker',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: msg,
    });
    return NextResponse.json(
      { success: false, status: 'failed', run_logged: runLogged, error: msg },
      { status: 500 },
    );
  }
}
