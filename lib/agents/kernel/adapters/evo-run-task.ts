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
 * причина в console.error, а вызывающий видит kind:'kernel_unavailable' и
 * отдаёт kernel_task_id: null в HTTP-ответе (§4.0 — «не смог записать» видно).
 *
 * ── Concurrency-guard (задание владельца 28.08) ──────────────────────────────
 *
 * `/api/cron/evo` до этой правки не был защищён от параллельного прогона ничем,
 * кроме `concurrency: cron-evo` в GitHub Actions — а это сериализует только
 * запуски ДРУГ С ДРУГОМ, не запрос откуда-то ещё (внешний cron-job.org,
 * ручной workflow_dispatch, запоздавший нативный прогон). Два оркестратора
 * разом — не просто трата денег: Evolution Loop пишет фиксы в БД и может
 * открыть PR, и гонка там опаснее, чем задержка budильника.
 *
 * `startEvoRunTask` теперь СНАЧАЛА спрашивает kernel: нет ли уже живой задачи
 * этой capability (findActiveByCapability, lease ещё не истёк). Есть —
 * возвращает `already_running`, и `runEvoOrchestrator` не зовётся вовсе.
 * Ключа идемпотентности у evo.run по-прежнему нет и не будет: каждый плановый
 * прогон — новая законная работа, а не повтор одного и того же входа; guard
 * блокирует не «второй раз то же самое», а «два прогона ОДНОВРЕМЕННО».
 */

import { claimTaskById, createTask, findActiveByCapability, appendEvent, transition } from '../kernel';
import type { OrchestratorResult } from '@/lib/agents/orchestrator';

export interface EvoRunHandle {
  taskId: string;
  traceId: string;
}

export type EvoRunStart =
  | { kind: 'started'; handle: EvoRunHandle }
  /** Другой прогон evo.run уже идёт (lease живой) — не запускаем второй. */
  | { kind: 'already_running'; activeTaskId: string }
  /** kernel недоступен/упал — fail-soft: прогон продолжается без него. */
  | { kind: 'kernel_unavailable' };

export async function startEvoRunTask(scanType: string): Promise<EvoRunStart> {
  try {
    const active = await findActiveByCapability('evo.run');
    if (active) return { kind: 'already_running', activeTaskId: active.id };

    const outcome = await createTask({
      principal: 'cron:evo',
      capability: 'evo.run',
      risk: 'safe',
      state: 'queued',
      details: { scan_type: scanType },
    });
    if (!outcome.created) return { kind: 'kernel_unavailable' }; // ключей у evo.run нет — ветка недостижима
    // Захват СВОЕЙ задачи по id (исправление 27.08: захват «старейшей той же
    // capability» под конкуренцией прогонов исполнялся бы под чужим task_id);
    // lease фиксируется до исполнения стадий.
    const claimed = await claimTaskById(outcome.task.id, 'cron:evo', 600);
    if (!claimed) return { kind: 'kernel_unavailable' };
    return { kind: 'started', handle: { taskId: claimed.id, traceId: claimed.trace_id } };
  } catch (err) {
    console.error('[kernel/evo] задача прогона не заведена:', err instanceof Error ? err.message : err);
    return { kind: 'kernel_unavailable' };
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
