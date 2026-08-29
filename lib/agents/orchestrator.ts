/**
 * Agent Orchestrator — параллельный запуск агентов Evo-системы.
 *
 * Запускает Growth, Rescue, Evolver Analysis параллельно (Promise.allSettled).
 * Evolution Loop остаётся последовательным — он пишет в БД и должен завершиться.
 * Итог: ~3x быстрее при том же timeout 120s.
 *
 * Консолидация 29.08 (решение владельца): расписание evo.run — теперь
 * единственный живой пульс системы (внешний cron-job.org, 4×/сутки каждые
 * 6ч — нативные GH Actions расписания ненадёжны, см. аудит 28.08). Четыре
 * агента, у которых раньше были СВОИ отдельные суточные кроны (Scout
 * Digest 07:00 UTC, Scout Innovator 08:00 UTC, и два внешних — Industry
 * Intel, Memory Reflector), переехали сюда — общий пульс вместо N
 * рассинхронизированных, токены тратятся по одному расписанию, а не по
 * N подряд не связанных.
 */

import { runGrowthScan } from '@/lib/agents/evo/growth-agent';
import { runEvolutionLoop } from '@/lib/agents/evo/evolution-loop';
import { runRescueScan } from '@/lib/agents/evo/rescue-agent';
import { runEvolverAnalysis } from '@/lib/agents/evo/evolver-analysis';
import { bridgeScoutIntel } from '@/lib/agents/evo/intel-bridge';
import { runModelWatcher } from '@/lib/agents/evo/model-watcher';
import { runScoutDigest } from '@/lib/agents/scout-digest';
import { runScoutInnovator } from '@/lib/agents/scout-innovator';
import { scanIndustryChannels } from '@/lib/telegram/industry-channels';
import { runMemoryReflector } from '@/lib/agents/memory-reflector';

export interface OrchestratorResult {
  scan: unknown;
  evolution: unknown;
  rescue: unknown;
  evolver: unknown;
  intel: unknown;
  models: unknown;
  scoutDigest: unknown;
  scoutInnovator: unknown;
  industryIntel: unknown;
  memoryReflector: unknown;
  duration_ms: number;
  errors: string[];
}

export async function runEvoOrchestrator(scanType = 'full'): Promise<OrchestratorResult> {
  const start = Date.now();
  const errors: string[] = [];

  // Phase 1: параллельно — диагностика (внутрь) + безопасность + анализ логов +
  // мост разведки (наружу): дайджест Scout → находки 'intel' в общий пул +
  // четыре бывших отдельных crona (см. комментарий файла).
  const [scanRes, rescueRes, evolverRes, intelRes, modelsRes, scoutDigestRes, scoutInnovatorRes, industryIntelRes, memoryReflectorRes] = await Promise.allSettled([
    runGrowthScan(scanType),
    runRescueScan(),
    runEvolverAnalysis(),
    bridgeScoutIntel(),
    runModelWatcher(),
    runScoutDigest(),
    runScoutInnovator(),
    scanIndustryChannels(),
    runMemoryReflector(),
  ]);

  // Phase 2: Evolution Loop — последовательно (применяет фиксы, пишет в БД)
  let evoResult: unknown = null;
  try {
    const evolution = await runEvolutionLoop();
    evoResult = evolution;
    if (evolution.errors > 0) {
      errors.push(`EvolutionLoop: ${evolution.errors} issue(s) failed`);
    }
  } catch (err) {
    errors.push(`Evolution: ${err instanceof Error ? err.message : String(err)}`);
  }

  function unwrap<T>(settled: PromiseSettledResult<T>, name: string): T | null {
    if (settled.status === 'fulfilled') return settled.value;
    errors.push(`${name}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
    return null;
  }

  return {
    scan: unwrap(scanRes, 'GrowthScan'),
    evolution: evoResult,
    rescue: unwrap(rescueRes, 'RescueScan'),
    evolver: unwrap(evolverRes, 'EvolverAnalysis'),
    intel: unwrap(intelRes, 'IntelBridge'),
    models: unwrap(modelsRes, 'ModelWatcher'),
    scoutDigest: unwrap(scoutDigestRes, 'ScoutDigest'),
    scoutInnovator: unwrap(scoutInnovatorRes, 'ScoutInnovator'),
    industryIntel: unwrap(industryIntelRes, 'IndustryIntel'),
    memoryReflector: unwrap(memoryReflectorRes, 'MemoryReflector'),
    duration_ms: Date.now() - start,
    errors,
  };
}
