/**
 * Как тур выезжает — правило чтения `operator_tours.schedule_kind` в одном
 * месте (#3476, слово владельца 16.11 «Да, так», миграция 1455).
 *
 * Тур без строк календаря раньше всегда был «Даты по запросу», и под этой
 * подписью смешивались два случая: оператор выезжает в любой день сезона,
 * если набирается группа, — и оператор просто не опубликовал даты. Признак
 * их разделяет:
 *
 *   - `departures` — только даты календаря;
 *   - `any_day`    — любой день между `season_start` и `season_end`; строка
 *                    календаря у такого тура — исключение (закрыть день,
 *                    ограничить места), а не выезд;
 *   - `null`       — не указано (§4.0): как раньше, «Даты по запросу».
 *
 * «Любой день сезона» без записанного сезона — не указано: сказать «любой
 * день» без границ значило бы обещать и зиму у летнего тура. Окно выезда —
 * то же, что у заявки без календаря (`requestWindow`): поездка должна
 * закончиться в сезоне. Сезон прошёл или тур в него не помещается —
 * `any_day` не действует, и витрина говорит о сезоне прежними словами.
 *
 * Чистый модуль: без базы, безопасен для клиента.
 * Сторож: tests/unit/schedule-kind.test.ts.
 */

import { requestWindow, windowLabel, type RequestWindow, type WindowInput } from '@/lib/tours/request-window';

export const SCHEDULE_KINDS = ['departures', 'any_day'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Значение колонки → признак; всё прочее (NULL, мусор) — «не указано». */
export function scheduleKindOf(v: unknown): ScheduleKind | null {
  return typeof v === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(v) ? (v as ScheduleKind) : null;
}

export type ScheduleKindInput = WindowInput & { schedule_kind?: unknown };

export type AnyDayWindow = Extract<RequestWindow, { kind: 'season' }>;

/**
 * Окно «любой день сезона» на день `today` ('YYYY-MM-DD' по Камчатке): даты
 * выезда с `from` по `to`. null — тур не `any_day`, сезон не записан, прошёл
 * или короче самого тура.
 */
export function anyDayWindow(t: ScheduleKindInput, today: string): AnyDayWindow | null {
  if (scheduleKindOf(t.schedule_kind) !== 'any_day') return null;
  const w = requestWindow(t, today);
  return w.kind === 'season' ? w : null;
}

/** Выезжает ли тур в любой день сезона, и сезон ещё идёт или впереди. */
export function isAnyDayOpen(t: ScheduleKindInput, today: string): boolean {
  return anyDayWindow(t, today) !== null;
}

/** «любой день сезона, сезон 15 июля 2027 — 15 октября 2027» — фраза для списков. */
export function anyDayPhrase(w: AnyDayWindow): string {
  return `любой день сезона, ${windowLabel(w)} — место подтверждает оператор`;
}
