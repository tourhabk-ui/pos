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

/** Кем крон наблюдается на «запускался ли вообще». */
export type LivenessWatch = 'safety' | 'nonsafety' | 'no_telemetry' | 'watched_elsewhere';

/**
 * Разбиение реестра по сторожам живости — ОДНО и в одном месте (19.09).
 *
 * До этого дня отбор жил лямбдой внутри watchdog.ts и звучал так:
 * `tier === 'safety' && agentId !== 'safety-ingest' && agentId !== 'watchdog'`.
 * Всё, что в это условие не попадало, не наблюдалось НИКЕМ, и знать об этом
 * было неоткуда: условие не говорит, кто остался снаружи. Снаружи остались
 * семь восьмых реестра, включая `health` — тот самый крон, который и
 * сообщает владельцу о поломках. Три часа его немоты 19.09 не заметил никто.
 *
 * Функция чистая и возвращает ЧЕТВЁРТЫЙ исход вместо умолчания: «не
 * наблюдается здесь» — это либо «нет телеметрии» (agentId === null, сказать
 * нечем), либо «наблюдается в другом месте», и у второго обязано быть имя
 * этого места. Молчаливого «прочие» тут нет намеренно — §4.0.
 *
 * Сторож связки: tests/unit/cron-liveness-watched.test.ts. Он требует, чтобы
 * у КАЖДОГО исхода был потребитель в watchdog.ts: разбиение, половину
 * которого никто не читает, зеленеет ровно тогда, когда наблюдение отвалилось.
 */
export function livenessWatch(e: Pick<CronEntry, 'tier' | 'agentId'>): LivenessWatch {
  // Нет отметок в agent_run_history — сказать о живости нечего. Панель
  // показывает такой крон как 'unknown', и тревожить о нём нельзя: это было бы
  // утверждение о том, чего не измеряли.
  if (e.agentId === null) return 'no_telemetry';
  // У сейсмо-приёмника свой, более строгий сторож (checkSeismicCronDead,
  // порог 15 мин против 150): общий поднял бы тревогу на десять часов позже.
  if (e.agentId === 'safety-ingest') return 'watched_elsewhere';
  // Рапорт «Watchdog молчит» из работающего Watchdog логически противоречив:
  // раз проверка идёт, сторож жив. Свою живость он подтвердить не может —
  // это дело внешнего мониторинга.
  if (e.agentId === 'watchdog') return 'watched_elsewhere';
  return e.tier === 'safety' ? 'safety' : 'nonsafety';
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
