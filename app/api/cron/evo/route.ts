/**
 * GET /api/cron/evo
 *
 * Evo System — параллельная оркестрация агентов.
 * Growth + Rescue + Evolver Analysis запускаются одновременно.
 * Evolution Loop — последовательно (пишет фиксы в БД).
 *
 * URL: https://vedarai.ru/api/cron/evo?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runEvoOrchestrator } from '@/lib/agents/orchestrator';
import { buildEvoAlert } from '@/lib/agents/evo/alert';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';
import { startEvoRunTask, finishEvoRunTask, failEvoRunTask } from '@/lib/agents/kernel/adapters/evo-run-task';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scanType = request.nextUrl.searchParams.get('type') ?? 'full';
  const startedAt = new Date();

  // Kernel-задача прогона: durable identity + стадии событиями. Fail-soft —
  // отказ kernel не роняет крон, но виден: kernel_task_id: null в ответе.
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
