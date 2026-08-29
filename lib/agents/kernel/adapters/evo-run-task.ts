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
 *
 * Concurrency-guard живёт НЕ здесь, а в app/api/cron/evo/route.ts —
 * `pg_try_advisory_lock` вокруг всего вызова, до того как эта функция вообще
 * позовётся. Здесь его не было и не будет намеренно: kernel — наблюдатель
 * прогона (см. выше), а не место для мьютекса поверх него.
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

const STAGES: ReadonlyArray<keyof Pick<OrchestratorResult,
  'scan' | 'evolution' | 'rescue' | 'evolver' | 'intel' | 'models' |
  'scoutDigest' | 'scoutInnovator' | 'industryIntel' | 'memoryReflector'>> =
  ['scan', 'evolution', 'rescue', 'evolver', 'intel', 'models',
   'scoutDigest', 'scoutInnovator', 'industryIntel', 'memoryReflector'];

/**
 * У каждой стадии свой диагноз «сделал ли то, ради чего звался» — и это НЕ
 * то же самое, что `ok` (== «не упал»). 29.08: scoutInnovator годами мог
 * отвечать ok:true, пока GITHUB_ISSUES_TOKEN отсутствовал на проде — сам
 * агент это знал (`phase1_diag: '...НЕ задан на проде...'`), но строка
 * терялась здесь же, до записи события. Владелец видел зелёную плитку и не
 * мог понять, почему issue не появляются (§4.0 — выброшенный диагноз это
 * та же беда, что и молчащий catch).
 *
 * Разные стадии — разные поля результата, общего интерфейса у них нет
 * (унаследовано от того, что каждая писалась отдельным агентом до
 * консолидации 29.08). Вместо выдумывания общего контракта — по имени.
 */
export function stageDiag(stage: string, value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  switch (stage) {
    case 'scoutDigest': {
      const reason = v.digest_skip_reason;
      const detail = v.digest_skip_detail;
      if (typeof reason !== 'string') return undefined;
      return typeof detail === 'string' && detail ? `${reason}: ${detail}` : reason;
    }
    case 'scoutInnovator':
      return typeof v.phase1_diag === 'string' ? v.phase1_diag : undefined;
    case 'industryIntel': {
      const errors = v.errors;
      return Array.isArray(errors) && errors.length > 0 ? errors.join('; ') : undefined;
    }
    case 'memoryReflector':
      return typeof v.reason === 'string' ? v.reason : undefined;
    default:
      return undefined;
  }
}

export async function finishEvoRunTask(handle: EvoRunHandle, result: OrchestratorResult): Promise<void> {
  try {
    for (const stage of STAGES) {
      const value = result[stage];
      const diag = stageDiag(stage, value);
      await appendEvent(handle.taskId, 'cron:evo', 'note', {
        stage,
        ok: value !== null,
        ...(diag ? { diag } : {}),
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
