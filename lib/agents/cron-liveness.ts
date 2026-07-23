/**
 * lib/agents/cron-liveness.ts
 *
 * Чистая логика живости cron-агента: по расписанию (everyMin) и времени
 * последнего запуска решает «жив / опоздал / мёртв». Без сети и БД — тестируемо.
 *
 * Честность: нет телеметрии (agentId === null) → 'unknown', НЕ зелёный. Есть
 * телеметрия, но запусков нет → 'never'. Зелёным помечаем только реально
 * отметившуюся вовремя джобу.
 */

import type { CronEntry, CronTier } from './cron-registry';

export type LivenessStatus = 'alive' | 'late' | 'dead' | 'never' | 'unknown';

export interface Liveness {
  status: LivenessStatus;
  /** Минут с последнего запуска, либо null если запусков/телеметрии нет */
  minutesSince: number | null;
  /** Порог «опоздал», мин */
  lateAfterMin: number;
  /** Порог «мёртв», мин */
  deadAfterMin: number;
}

// Множители порога и добавка-грация по разряду. Безопасность — самый строгий.
const TIER_THRESHOLD: Record<CronTier, { late: number; dead: number; graceMin: number }> = {
  safety: { late: 1.5, dead: 2.5, graceMin: 10 },
  ops: { late: 2, dead: 4, graceMin: 15 },
  quality: { late: 2, dead: 6, graceMin: 30 },
  growth: { late: 2, dead: 6, graceMin: 30 },
  content: { late: 2, dead: 6, graceMin: 30 },
};

export function livenessThresholds(entry: Pick<CronEntry, 'everyMin' | 'tier'>): { lateAfterMin: number; deadAfterMin: number } {
  const t = TIER_THRESHOLD[entry.tier];
  return {
    lateAfterMin: Math.round(entry.everyMin * t.late + t.graceMin),
    deadAfterMin: Math.round(entry.everyMin * t.dead + t.graceMin),
  };
}

/**
 * @param entry     запись реестра
 * @param lastRunMs время последнего запуска в мс (Date.getTime()) или null
 * @param nowMs     текущее время в мс
 */
export function computeLiveness(
  entry: Pick<CronEntry, 'everyMin' | 'tier' | 'agentId'>,
  lastRunMs: number | null,
  nowMs: number,
): Liveness {
  const { lateAfterMin, deadAfterMin } = livenessThresholds(entry);

  if (entry.agentId === null) {
    return { status: 'unknown', minutesSince: null, lateAfterMin, deadAfterMin };
  }
  if (lastRunMs === null) {
    return { status: 'never', minutesSince: null, lateAfterMin, deadAfterMin };
  }

  const minutesSince = Math.max(0, Math.round((nowMs - lastRunMs) / 60000));
  const status: LivenessStatus =
    minutesSince <= lateAfterMin ? 'alive' : minutesSince <= deadAfterMin ? 'late' : 'dead';

  return { status, minutesSince, lateAfterMin, deadAfterMin };
}

/**
 * Сводный вердикт по набору: «что-то горит», если хоть один safety-агент
 * dead/late или любой другой — dead. Иначе «спокойно».
 */
export function overallPosture(
  items: Array<{ tier: CronTier; status: LivenessStatus }>,
): 'calm' | 'attention' | 'alarm' {
  let attention = false;
  for (const it of items) {
    if (it.tier === 'safety' && (it.status === 'dead' || it.status === 'never')) return 'alarm';
    if (it.status === 'dead' || it.status === 'never') attention = true;
    if (it.tier === 'safety' && it.status === 'late') attention = true;
  }
  return attention ? 'attention' : 'calm';
}
