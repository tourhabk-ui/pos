/**
 * lib/agents/scout-digest-run.ts — прогон разведчика С ЖУРНАЛОМ.
 *
 * Разведчик запускается двумя дорогами: крон-роут /api/cron/scout-digest
 * (расписание cron-scout-digest.yml и ручной маркер; с 29.08 по 05.09 был
 * стадией runEvoOrchestrator, вынесен обратно — съедал весь бюджет
 * evo.run) и кнопка в админке. До 04.09 журнал
 * agent_run_history вёл ТОЛЬКО роут: выпуск 04.09 00:02 UTC вышел из
 * оркестратора, а разбор «почему молчит» (scout-diagnose) и счёт тишины
 * (silent_runs) читали журнал и видели последний прогон 03.09 15:59.
 * Штатные прогоны были невидимы, ручные — единственной правдой.
 *
 * Здесь один вход для всех трёх дорог. Кто позвал — в metadata.trigger:
 * без этого поля три дороги в журнале неотличимы, а чинят их по-разному.
 *
 * Причина пропуска и улика ДОЛЖНЫ пережить запрос (урок 1–13.08: причина
 * жила в HTTP-ответе крона и через сутки была недостижима). `null` при
 * отправленном выпуске — «проверено, причины нет», а не «не записали»:
 * поле есть всегда. То же для второго канала: ai_channel_* до 04.09 в
 * журнал не писались вовсе, и scout-diagnose честно печатал «исход канала
 * не записан» на каждом прогоне.
 */

import { runScoutDigest, type DigestResult } from '@/lib/agents/scout-digest';
import { logAgentRun } from '@/lib/agents/run-logger';
import { runWithUsageTracking, type UsageSnapshot } from '@/lib/ai/usage-context';

// 'orchestrator' снят 05.09: дайджест снова идёт своим кроном, стадии в
// эволюции нет (замер 389: дайджест съедал весь бюджет evo.run).
export type ScoutTrigger = 'cron' | 'admin';

export interface JournaledDigestRun {
  result: DigestResult;
  usage: UsageSnapshot;
  started_at: Date;
}

export async function runScoutDigestJournaled(trigger: ScoutTrigger): Promise<JournaledDigestRun> {
  const started_at = new Date();
  try {
    const { result, usage } = await runWithUsageTracking('scout-digest', () => runScoutDigest());
    void logAgentRun({
      agent_id: 'scout-digest',
      status: result.digest_sent ? 'success' : 'partial',
      started_at,
      duration_ms: result.duration_ms,
      items_processed: result.signals_found,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      llm_calls: usage.llm_calls,
      estimated_cost_usd: usage.estimated_cost_usd,
      metadata: {
        trigger,
        digest_skip_reason: result.digest_skip_reason ?? null,
        // Улика переживает запрос вместе с причиной: без неё «ответила
        // прозой» остаётся догадкой, а догадка уже стоила трёх недель.
        digest_skip_detail: result.digest_skip_detail ?? null,
        // Выпуск ушёл, но без вычеркнутых пунктов (02.09): число и какие.
        claims_dropped: result.claims_dropped ?? null,
        claims_dropped_detail: result.claims_dropped_detail ?? null,
        // Второй канал — отдельная судьба: дайджест мог уйти, а пост — нет.
        ai_channel_sent: result.ai_channel_sent ?? null,
        ai_channel_skip_reason: result.ai_channel_skip_reason ?? null,
        ai_channel_skip_detail: result.ai_channel_skip_detail ?? null,
      },
    });
    return { result, usage, started_at };
  } catch (err) {
    void logAgentRun({
      agent_id: 'scout-digest',
      status: 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
      metadata: { trigger },
    });
    throw err;
  }
}
