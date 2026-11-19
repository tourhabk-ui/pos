/**
 * lib/trips/trip-replace-day.ts — замена дня сохранённой поездки новым
 * черновиком. Только сервер.
 *
 * Слово владельца 19.11: «3394 срез 2 делай» (#3394, остаток #3347, рек. 2:
 * «при новом предупреждении — предложить замену дня как новый черновик»).
 *
 * Страница поездки перепроверяет план (`lib/trips/trip-now`) и называет, что
 * у дня появилось новое предупреждение. Отсюда человек выбирает другое
 * занятие на этот день. Правило замены — то же, что у Кузьмича и MCP
 * (`applyPlanEdit`, `replace_day`): движок подбирает день мини-поездкой в ту
 * же дату и зону, каркас поездки и день многодневного тура не заменяются,
 * строки парков, предупреждений и МЧС перечитываются на все дни.
 *
 * Результат ложится НОВЫМ черновиком (`trip_plan_drafts`, поверхность
 * 'cabinet', миграция 1465) и открывается на /trip/<id>. Сохранённая поездка
 * не меняется: в ней снимок предупреждений на день сохранения, а черновик —
 * свежая версия, которую человек смотрит и решает сам.
 *
 * Чего не делаем: не выбираем занятие за человека и не обещаем, что замена
 * снимет предупреждение. Штормовое предупреждение по зоне останется и на
 * новом дне — ответ показывает строки нового дня как есть.
 */
import type { DayPlan } from '@/lib/planner/engine';
import { applyPlanEdit, type EditablePlan, type EditDeps } from '@/lib/planner/plan-edit';
import { saveDraft, type DraftSurface } from '@/lib/planner/plan-drafts';
import { ACTIVITY_NAMES } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { kamchatkaToday } from '@/lib/planner/calendar-days';
import { TripPartySchema } from './trip-schema';
import type { ReplaceDayOutcome } from './trip-now-types';

/** Сохранённая поездка — поля, которые нужны замене дня. */
export interface SavedTripForReplace {
  arrival_date: string | null;
  departure_date: string | null;
  activities?: readonly string[] | null;
  days: readonly unknown[];
  party?: unknown;
}

export type { ReplacedDay, ReplaceDayOutcome } from './trip-now-types';

export interface ReplaceDayDeps {
  edit?: EditDeps;
  save: (plan: EditablePlan, surface: DraftSurface, wishes: string | undefined) => Promise<string | null>;
  now: () => Date;
}

export const DEFAULT_REPLACE_DEPS: ReplaceDayDeps = {
  save: saveDraft,
  now: () => new Date(),
};

/** Ключи занятий, на которые можно заменить день. */
export const REPLACE_INTERESTS = Object.keys(ACTIVITY_NAMES) as [string, ...string[]];

const NO_PARTY = 'Поездка сохранена без состава группы — подобрать замену не на что. Соберите план заново на те же даты.';
const NO_DATES = 'У поездки не записаны даты — подобрать замену дня не на что.';
const BAD_DAYS = 'Дни поездки не читаются — подобрать замену не получилось.';

function isDay(v: unknown): v is { day: number; zone: string; type?: string; dayWarnings?: unknown } {
  if (!v || typeof v !== 'object') return false;
  const d = v as { day?: unknown; zone?: unknown };
  return typeof d.day === 'number' && Number.isInteger(d.day) && d.day >= 1 && typeof d.zone === 'string';
}

/**
 * План движка из сохранённой поездки. Дни берутся как сохранены: полей,
 * которых в поездке нет (описание, сложность), не выдумываем — правило замены
 * их у старых дней не читает. Род дня у поездок до 07.11 не записан —
 * считаем занятием, как страница по ссылке.
 */
export function editablePlanFromTrip(trip: SavedTripForReplace): { ok: true; plan: EditablePlan } | { ok: false; reason: string } {
  if (!trip.arrival_date || !trip.departure_date) return { ok: false, reason: NO_DATES };
  const party = TripPartySchema.safeParse(trip.party);
  if (!party.success) return { ok: false, reason: NO_PARTY };
  if (!trip.days.every(isDay)) return { ok: false, reason: BAD_DAYS };
  const days = trip.days.map((d) => {
    const day = d as { type?: string; dayWarnings?: unknown };
    return {
      ...(d as object),
      type: day.type ?? 'activity',
      dayWarnings: Array.isArray(day.dayWarnings) ? day.dayWarnings.filter((w): w is string => typeof w === 'string') : [],
    } as unknown as DayPlan;
  });
  return {
    ok: true,
    plan: {
      params: {
        interests: (trip.activities ?? []).filter((k) => k in ACTIVITY_NAMES),
        arrivalDate: trip.arrival_date.slice(0, 10),
        departureDate: trip.departure_date.slice(0, 10),
        adults: party.data.adults,
        children: [...party.data.children],
        budgetTier: party.data.budgetTier,
      },
      days,
    },
  };
}

/** Заменить день `dayNum` занятием `interest` и положить результат новым черновиком. */
export async function replaceTripDay(
  trip: SavedTripForReplace,
  dayNum: number,
  interest: string,
  deps: ReplaceDayDeps = DEFAULT_REPLACE_DEPS,
): Promise<ReplaceDayOutcome> {
  if (!(interest in ACTIVITY_NAMES)) return { state: 'refused', reason: `Занятие «${interest}» планер не знает.` };
  const built = editablePlanFromTrip(trip);
  if (!built.ok) return { state: 'refused', reason: built.reason };
  const date = dateOfTripDay(built.plan.params.arrivalDate, dayNum);
  if (!date) return { state: 'refused', reason: BAD_DAYS };
  if (date < kamchatkaToday(deps.now())) {
    return { state: 'refused', reason: `День ${dayNum} уже прошёл — заменять его поздно.` };
  }

  const res = deps.edit
    ? await applyPlanEdit(built.plan, { kind: 'replace_day', day: dayNum, interest }, deps.edit)
    : await applyPlanEdit(built.plan, { kind: 'replace_day', day: dayNum, interest });
  if (!res.ok) return { state: 'refused', reason: res.reason };

  const newDay = res.plan.days.find((d) => d.day === dayNum);
  if (!newDay) return { state: 'failed', reason: 'Замена не собралась — попробуйте ещё раз.' };
  const id = await deps.save(res.plan, 'cabinet', undefined);
  if (!id) return { state: 'failed', reason: 'Замена подобрана, но черновик не записался — попробуйте ещё раз.' };

  const dayWarnings = [...(newDay.dayWarnings ?? [])];
  return {
    state: 'drafted',
    draft_id: id,
    note: res.note,
    day: { day: dayNum, date, title: newDay.title, zone: newDay.zone, warnings: dayWarnings },
    plan_warnings: (res.warnings ?? []).filter((w) => !dayWarnings.includes(w)),
  };
}
