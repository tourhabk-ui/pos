/**
 * Kernel-адаптер контура Evo: прогон оркестратора — durable task со стадиями.
 *
 * Задача отражает ПРОГОН, стадии — события note, внешние эффекты
 * (Issue/PR/уведомления) фиксируют СВОИ шаги отдельными effect-событиями —
 * прогон целиком эффектом не считается (решение владельца 27.08).
 *
 * Исход прогона: без ошибок → succeeded; с ошибками стадий → failed_terminal
 * с summary «partial: …» — partial это исход ПРОГОНА, не состояние задачи;
 * повторов у этой задачи нет, следующий плановый прогон — НОВАЯ задача.
 *
 * Fail-soft НАМЕРЕННО: kernel — наблюдатель прогона, а не его условие.
 * Отказ записи kernel не роняет cron (safety-требование), но не молчит:
 * причина в console.error, а вызывающий видит null вместо handle и отдаёт
 * kernel_task_id: null в HTTP-ответе (§4.0 — «не смог записать» видно).
 */

import { claimTaskById, createTask, appendEvent, transition } from '../kernel';
import type { OrchestratorResult } from '@/lib/agents/orchestrator';

export interface EvoRunHandle {
  taskId: string;
  traceId: string;
}

export async function startEvoRunTask(scanType: string): Promise<EvoRunHandle | null> {
  try {
    const outcome = await createTask({
      principal: 'cron:evo',
      capability: 'evo.run',
      risk: 'safe',
      state: 'queued',
      details: { scan_type: scanType },
    });
    if (!outcome.created) return null; // ключей у evo.run нет — ветка недостижима
    // Захват СВОЕЙ задачи по id (исправление 27.08: захват «старейшей той же
    // capability» под конкуренцией прогонов исполнялся бы под чужим task_id);
    // lease фиксируется до исполнения стадий.
    const claimed = await claimTaskById(outcome.task.id, 'cron:evo', 600);
    if (!claimed) return null;
    return { taskId: claimed.id, traceId: claimed.trace_id };
  } catch (err) {
    console.error('[kernel/evo] задача прогона не заведена:', err instanceof Error ? err.message : err);
    return null;
  }
}

const STAGES: ReadonlyArray<keyof Pick<OrchestratorResult, 'scan' | 'evolution' | 'rescue' | 'evolver' | 'intel' | 'models'>> =
  ['scan', 'evolution', 'rescue', 'evolver', 'intel', 'models'];

export async function finishEvoRunTask(handle: EvoRunHandle, result: OrchestratorResult): Promise<void> {
  try {
    for (const stage of STAGES) {
      await appendEvent(handle.taskId, 'cron:evo', 'note', {
        stage,
        ok: result[stage] !== null,
      });
    }
    const partial = result.errors.length > 0;
    await transition(
      handle.taskId,
      'running',
      partial ? 'failed_terminal' : 'succeeded',
      'cron:evo',
      {
        summary: partial
          ? `partial: ${result.errors.length} ошибок стадий за ${result.duration_ms}ms`
          : `completed за ${result.duration_ms}ms`,
        errors: result.errors,
      },
    );
  } catch (err) {
    console.error('[kernel/evo] итог прогона не записан:', err instanceof Error ? err.message : err);
  }
}

export async function failEvoRunTask(handle: EvoRunHandle, message: string): Promise<void> {
  try {
    await transition(handle.taskId, 'running', 'failed_terminal', 'cron:evo', {
      summary: `прогон упал: ${message}`,
    });
  } catch (err) {
    console.error('[kernel/evo] отказ прогона не записан:', err instanceof Error ? err.message : err);
  }
}
