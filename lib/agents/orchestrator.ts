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
 *
 * Rescue вынесен ОТСЮДА 08.09 (issue #1725) — обратным ходом к той же
 * консолидации, и по той же причине, по которой 05.09 вынули Scout Digest.
 * Он шёл двумя расписаниями сразу: свой крон каждые 30 минут (safety-tier, с
 * арендой окна) и ещё три раза в сутки здесь, БЕЗ аренды — то есть аренда
 * его не останавливала. Работа делалась заново, тревоги дублировались,
 * бюджет эволюции тратился впустую. Остался свой крон: погодные угрозы
 * ближайшим турам — safety, им место каждые полчаса, а не трижды в сутки.
 *
 * Scout Digest вынесен ОБРАТНО в свой крон 05.09 (решение владельца). Замер
 * прогона 389: весь evo.run 321 с, из них дайджест — 321 с; прочие стадии
 * вместе меньше 30 с. Роут живёт с maxDuration = 300, и три прогона подряд
 * (386-388) умерли на сервере без ответа и без записи — дайджест один съедал
 * бюджет всей эволюции. Он идёт из cron-scout-digest.yml с собственным
 * потолком; стадия `scoutDigest` в результате остаётся как честная отметка
 * «не здесь», чтобы кокпит и адаптер ядра не потеряли поле.
 */

import { runGrowthScan } from '@/lib/agents/evo/growth-agent';
import { runEvolutionLoop } from '@/lib/agents/evo/evolution-loop';
import { runEvolverAnalysis } from '@/lib/agents/evo/evolver-analysis';
import { bridgeScoutIntel } from '@/lib/agents/evo/intel-bridge';
import { runModelWatcher } from '@/lib/agents/evo/model-watcher';
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
  const [scanRes, evolverRes, intelRes, modelsRes, scoutInnovatorRes, industryIntelRes, memoryReflectorRes] = await Promise.allSettled([
    runGrowthScan(scanType),
    // Rescue здесь НЕ идёт с 08.09 (issue #1725). Он шёл двумя расписаниями
    // сразу: свой крон каждые 30 минут (cron-rescue.yml, safety-tier, с
    // арендой окна claimCronWindow) и ещё три раза в сутки отсюда — а этот
    // путь звал функцию напрямую, аренду не брал, и остановить его было
    // нечем. Итог: до 51 прогона в сутки вместо 48, из них три могли лечь
    // через минуту после планового, с дублирующимися тревогами в Telegram,
    // и бюджет эволюции тратился на только что сделанную работу — ровно та
    // болезнь, из-за которой 05.09 отсюда вынули Scout Digest.
    //
    // Оставлен свой крон: Rescue в safety-tier, и погодные угрозы ближайшим
    // турам проверяются каждые полчаса, а не трижды в сутки.
    runEvolverAnalysis(),
    bridgeScoutIntel(),
    runModelWatcher(),
    // Scout Digest здесь НЕ идёт с 05.09 — свой крон (см. шапку файла).
    // intel-bridge выше читает последний выпуск из базы знаний, а не ждёт
    // его от этого же прогона.
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

  const reflector = unwrap(memoryReflectorRes, 'MemoryReflector');
  // Стадия «выполнилась», а работа пропала: рефлектор мог получить инсайты и
  // не записать ни одного. Раньше это выглядело отсюда как чистый прогон
  // (находка аудита 08.09).
  if (reflector?.verdict === 'failed') {
    errors.push(
      `MemoryReflector: инсайты потеряны при записи — получено ${reflector.attempted}, записано ${reflector.consolidated}`,
    );
  } else if (reflector?.verdict === 'unknown') {
    errors.push(`MemoryReflector: работу выполнить не смог (${reflector.reason ?? 'причина не названа'})`);
  }
  return {
    scan: unwrap(scanRes, 'GrowthScan'),
    evolution: evoResult,
    // Честная отметка вместо результата — как у scoutDigest ниже: стадии
    // здесь больше нет, и молчания на её месте быть не должно.
    rescue: { skipped: true, rescue_skip_reason: 'own_cron' },
    evolver: unwrap(evolverRes, 'EvolverAnalysis'),
    intel: unwrap(intelRes, 'IntelBridge'),
    models: unwrap(modelsRes, 'ModelWatcher'),
    // Честная отметка вместо результата: stageDiag ядра читает
    // digest_skip_reason и запишет «own_cron», а не молчание.
    scoutDigest: {
      skipped: true,
      digest_skip_reason: 'own_cron',
      digest_skip_detail: 'дайджест идёт своим кроном (cron-scout-digest.yml), не стадией эволюции — 05.09',
    },
    scoutInnovator: unwrap(scoutInnovatorRes, 'ScoutInnovator'),
    industryIntel: unwrap(industryIntelRes, 'IndustryIntel'),
    memoryReflector: reflector,
    duration_ms: Date.now() - start,
    errors,
  };
}
