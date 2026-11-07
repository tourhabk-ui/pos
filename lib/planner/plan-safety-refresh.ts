/**
 * lib/planner/plan-safety-refresh.ts — строки безопасности дня после правки,
 * которая сдвинула даты (аудит планировщика 07.11, M3).
 *
 * Две строки дня зависят от даты:
 *  - закрытие парка и «статус парка не известен» (lib/planner/park-status):
 *    закрытие накрывает день до своего срока, сезонное без даты — день в
 *    пределе от сводки;
 *  - сводка МЧС (lib/safety/mchs-bulletin): строка, срок которой кончается до
 *    начала поездки, о поездке не говорит (разбор 06.11).
 * До этой правки сдвиг дат их не трогал. Поездка, перенесённая с июля на
 * октябрь, не узнавала о межсезонном закрытии парков, а перенесённая ближе —
 * о сводке МЧС, которая теперь её касается.
 *
 * Здесь — те же функции, что у движка (`applyPlanParkStatus`,
 * `notesForPlanDay`, `splitWarningsForTrip`), на новые даты:
 *  - парк: прежние строки парка снимаются с дней, чья дата сменилась, и
 *    ставятся заново. Не смогли прочитать — прежние строки остаются (лучше
 *    лишняя осторожность, чем снятое закрытие) и план говорит «проверить не
 *    удалось»;
 *  - МЧС (если сменилась дата начала): строка, которая к новым датам не
 *    относится или больше не действует, снимается; новая — ставится. Не
 *    смогли прочитать — прежние строки остаются, план говорит «не прочитаны».
 * Прогноз погоды дня — на прежнюю дату, и с дня, чья дата сменилась, он
 * снимается: прогноза на новую дату нет, а чужой хуже никакого.
 */

import { pool } from '@/lib/db-pool';
import { applyPlanParkStatus, type PlanParkQuery } from './park-status';
import { loadActiveWarnings, type ActiveWarningLoad } from '@/lib/safety/active-warnings';
import {
  MCHS_UNREAD_NOTE, notesForPlanDay, offeringSentence, splitWarningsForTrip, warningDigest,
} from '@/lib/safety/mchs-bulletin';
import { ZONE_NAMES, type ZoneId } from './constants';
import { dateOfTripDay } from './flow-balance';
import type { DayPlan } from './engine';

export interface SafetyRefreshDeps {
  /** Действующие сводки МЧС — loadActiveWarnings. */
  loadWarnings: () => Promise<ActiveWarningLoad>;
  /** Запрос тревог парков — к базе. */
  parkQuery: PlanParkQuery;
}

export const DEFAULT_SAFETY_DEPS: SafetyRefreshDeps = {
  loadWarnings: loadActiveWarnings,
  parkQuery: async <T,>(sql: string, params: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: T[] },
};

/** Строка сводки МЧС на дне плана (offeringSentence). */
function isMchsNote(text: string): boolean {
  return text.startsWith('МЧС: ') && text.endsWith('Это нельзя называть безопасным или без риска.');
}

/** Строка парка на дне плана (parkNoteForDay). */
function isParkNote(text: string): boolean {
  return text.startsWith('Закрытие парка по сводке от ')
    || text.startsWith('Статус парка на этот день не известен:')
    || text.endsWith('. Уточните у дирекции парка, открыты ли маршруты, до выхода.');
}

/** Зоны дня для сводок МЧС: у переезда — обе, их названия стоят в заголовке. */
function dayZones(d: DayPlan): ZoneId[] {
  const zones = new Set<ZoneId>([d.zone]);
  if (d.type === 'travel') {
    for (const [id, name] of Object.entries(ZONE_NAMES) as Array<[ZoneId, string]>) {
      if (d.title.includes(name)) zones.add(id);
    }
    if (d.title.includes('Петропавловск')) zones.add('avachinsky');
  }
  return [...zones];
}

/** Дни, на которые сводки МЧС ставятся (как у движка): занятие и переезд. */
const MCHS_DAY_TYPES: ReadonlySet<string> = new Set(['activity', 'travel']);

/** Строки дня: у старого черновика поля может не быть. */
function notesOf(d: DayPlan): string[] {
  return Array.isArray(d.dayWarnings) ? d.dayWarnings : [];
}

export interface SafetyRefreshResult {
  /** Предупреждения плана для ответа: закрытия парков, сводка МЧС, «не смогли». */
  warnings: string[];
}

/**
 * Обновить строки безопасности на днях плана после правки дат.
 *
 * `days` — дни нового плана (меняются на месте); `movedDays` — номера дней,
 * чья дата сменилась; `startChanged` — сменилась ли дата начала поездки (от
 * неё сводки МЧС судят, говорят ли они о поездке).
 */
export async function refreshDatedSafety(
  days: DayPlan[],
  arrivalIso: string,
  movedDays: readonly number[],
  startChanged: boolean,
  deps: SafetyRefreshDeps = DEFAULT_SAFETY_DEPS,
): Promise<SafetyRefreshResult> {
  const warnings: string[] = [];
  const moved = new Set(movedDays);
  const movedPlan = days.filter((d) => moved.has(d.day));
  for (const d of movedPlan) delete d.weatherForecast;

  if (movedPlan.length > 0) {
    // Пробный проход на копиях: при отказе чтения прежние строки остаются.
    const trial = movedPlan.map((d) => ({ ...d, dayWarnings: notesOf(d).filter((t) => !isParkNote(t)) }));
    const park = await applyPlanParkStatus(trial, (n) => dateOfTripDay(arrivalIso, n), deps.parkQuery);
    if (!park.unread) {
      for (const t of trial) {
        const target = movedPlan.find((d) => d.day === t.day);
        if (target) target.dayWarnings = t.dayWarnings;
      }
    }
    warnings.push(...park.warnings.map((w) => w.message));
  }

  if (startChanged) {
    const mchs = await deps.loadWarnings();
    if (!mchs.ok) {
      warnings.push(MCHS_UNREAD_NOTE);
    } else {
      const { forTrip } = splitWarningsForTrip(mchs.warnings, arrivalIso);
      const stillTrue = new Set(forTrip.map(offeringSentence));
      for (const d of days) {
        if (!MCHS_DAY_TYPES.has(d.type)) continue;
        const kept = notesOf(d).filter((t) => !isMchsNote(t) || stillTrue.has(t));
        const fresh = notesForPlanDay(`${d.title} ${d.description ?? ''}`, dayZones(d), forTrip);
        d.dayWarnings = [...kept, ...fresh.filter((n) => !kept.includes(n))];
      }
      const digest = warningDigest(forTrip);
      if (digest) warnings.push(digest);
    }
  }
  return { warnings };
}
