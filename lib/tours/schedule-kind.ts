/**
 * Как тур выезжает — по своим датам или в любой день сезона (#3476, слово
 * владельца 16.11 «Да, так»; миграция 1457).
 *
 * `operator_tours.schedule_kind` — слово оператора:
 *   - `departures` — выезды только в даты его календаря (`tour_availability`);
 *   - `any_day`    — любой день между `season_start` и `season_end`; строка
 *                    календаря у такого тура — исключение (закрыть день,
 *                    ограничить места), а не единственная дата;
 *   - `null`       — не указано: как до 16.11, «Даты по запросу» (§4.0).
 *
 * «Тур в любой день сезона открыт сейчас» — одно правило на SQL и TypeScript:
 * признак `any_day`, сезон записан, и поездка, начатая не раньше сегодняшнего
 * дня по Камчатке, ещё успевает закончиться в сезоне — то же окно, что у
 * заявки без календаря (`requestWindow`, lib/tours/request-window). Сезон
 * кончился или не записан — тур «любой день» не открыт: обещать день, которого
 * в данных нет, нельзя.
 *
 * Порядок общих витрин (правило 1в, слово владельца 16.11 «Выезды первыми»):
 * сначала туры с настоящими выездами по ближайшей свободной дате, затем
 * открытые «в любой день сезона», затем остальные жребием дня —
 * lib/tours/offer-order.
 *
 * Сторожа: tests/unit/tour-schedule-kind.test.ts (правило и витрины);
 * SQL против TypeScript на PostgreSQL — tests/integration/public-tour-gate.pg.test.ts.
 */
import { requestWindow, type WindowInput } from '@/lib/tours/request-window';

export const SCHEDULE_KINDS = ['departures', 'any_day'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Значение колонки → признак; всё прочее, включая NULL, — «не указано». */
export function scheduleKindOf(v: unknown): ScheduleKind | null {
  return typeof v === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(v) ? v as ScheduleKind : null;
}

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * Сколько календарных дней занимает тур — SQL-двойник `tourDays`
 * (lib/tours/catalog-availability): многодневный — число дней, длиннее суток —
 * округление вверх, иначе один день.
 */
export function tourDaysSql(tourAlias: string): string {
  if (!ALIAS.test(tourAlias)) throw new Error(`tourDaysSql: недопустимый алиас «${tourAlias}»`);
  const a = tourAlias;
  return `(CASE
      WHEN ${a}.duration_type = 'multi_day' AND COALESCE(${a}.multi_day_count, 0) > 0 THEN ${a}.multi_day_count
      WHEN ${a}.duration_hours IS NOT NULL AND ${a}.duration_hours > 24 THEN CEIL(${a}.duration_hours / 24.0)::int
      ELSE 1
    END)`;
}

/**
 * SQL-условие «тур в любой день сезона открыт сегодня» для тура с алиасом
 * `tourAlias`. Ставится в SELECT как `any_day_open` и уходит в ключ порядка.
 */
export function anyDayOpenSql(tourAlias: string): string {
  if (!ALIAS.test(tourAlias)) throw new Error(`anyDayOpenSql: недопустимый алиас «${tourAlias}»`);
  const a = tourAlias;
  return `(${a}.schedule_kind = 'any_day'
      AND ${a}.season_start IS NOT NULL AND ${a}.season_end IS NOT NULL
      AND ${a}.season_end - (${tourDaysSql(a)} - 1) >= ${a}.season_start
      AND ${a}.season_end - (${tourDaysSql(a)} - 1) >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date)`;
}

/** TypeScript-двойник `anyDayOpenSql` для строк, у которых есть поля тура. */
export function anyDayOpen(t: WindowInput & { schedule_kind?: unknown }, today: string): boolean {
  return scheduleKindOf(t.schedule_kind) === 'any_day' && requestWindow(t, today).kind === 'season';
}
