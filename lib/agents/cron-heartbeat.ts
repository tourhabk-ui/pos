/**
 * lib/agents/cron-heartbeat.ts
 *
 * Лёгкий пульс cron-эндпоинта в agent_run_history для liveness-панели. Обёртка
 * над logAgentRun: fire-and-forget, никогда не бросает и не блокирует ответ
 * крон-джобы. Записываем ТОЛЬКО реальный исход — успех на success-пути, провал
 * в catch.
 *
 * ВАЖНО про liveness: отказ тоже пишется строкой с ended_at, и сторож жизни
 * (checkDeadSafetyCrons) считает такой крон ЖИВЫМ — он спрашивает «запускался
 * ли», а запускался. Здесь раньше стояло обратное обещание, и оно стоило
 * тринадцати дней: синк авиационных кодов вулканов падал каждые шесть часов с
 * 28.07, liveness видел свежую отметку, сторож холостых берёт только успешные
 * прогоны и потому не видел вовсе. Серию отказов ловит отдельная проверка —
 * lib/agents/cron-failing.ts.
 *
 * agentId должен совпадать с agentId в lib/agents/cron-registry.ts.
 */

import { logAgentRun } from './run-logger';

export function recordCronRun(
  agentId: string,
  startedAtMs: number,
  status: 'success' | 'failed',
  opts?: { items?: number; error?: string },
): void {
  void logAgentRun({
    agent_id: agentId,
    status,
    started_at: new Date(startedAtMs),
    duration_ms: Math.max(0, Date.now() - startedAtMs),
    items_processed: opts?.items,
    error_msg: opts?.error,
  });
}
