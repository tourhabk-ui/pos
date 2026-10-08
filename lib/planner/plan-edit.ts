/**
 * lib/planner/plan-edit.ts — правка готового плана поездки (#2224).
 *
 * План меняется не пересборкой с нуля, а правкой: «добавь день рыбалки»,
 * «убери третий день», «переставь», «жильё подешевле». То, чего правка не
 * касалась, остаётся как было — те же дни, те же туры, тот же порядок. До
 * этого make_trip_plan у Кузьмича и в MCP строил план заново на каждый вызов,
 * и любая правка тасовала весь план.
 *
 * Своего подбора здесь нет (CLAUDE.md: новый движок подбора заводить
 * запрещено). Новый день берётся у `recommendTrip` — тем же движком, той же
 * группой и тем же уровнем жилья, мини-поездкой на один активный день; цена
 * пересчитывается тем же `calculatePriceBreakdown`. Здесь — только операции
 * над списком дней и правила, когда правка невозможна.
 *
 * Правку вызывают инструменты Кузьмича и MCP (`edit_trip_plan`). Кнопки
 * веб-планера переводятся на эту же функцию следующим шагом (решение
 * владельца 08.10: «два шага»).
 */

import {
  recommendTrip, calculatePriceBreakdown, splitByChildAge,
  type DayPlan, type TripProfile, type BudgetTier, type PriceBreakdown, type TripRecommendation,
} from './engine';
import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES } from './constants';
import type { TravelStyle } from './travel-style';

/** Вход движка, по которому план собран. Свободного текста здесь нет. */
export interface PlanParams {
  /** Ключи интересов движка (volcano, fishing, ...). */
  interests: string[];
  /** Первый день поездки, YYYY-MM-DD. */
  arrivalDate: string;
  /** Последний день поездки, YYYY-MM-DD (включительно). */
  departureDate: string;
  adults: number;
  children: number[];
  budgetTier: BudgetTier;
  travelStyle?: TravelStyle;
  restDays?: number;
}

export interface EditablePlan {
  params: PlanParams;
  days: DayPlan[];
}

export type PlanEdit =
  | { kind: 'add_day'; interest: string }
  | { kind: 'remove_day'; day: number }
  | { kind: 'move_day'; day: number; to: number }
  | { kind: 'set_lodging'; tier: BudgetTier };

export type EditResult =
  | {
    ok: true; plan: EditablePlan; note: string;
    /**
     * Предупреждения движка о добавленном занятии (безопасность, разрешения,
     * сезон, подготовка). Без них «добавь день рыбалки» потерял бы «нужна
     * путёвка» и «территория медведей», которые сказал бы полный план.
     */
    warnings?: string[];
  }
  | { ok: false; reason: string };

/**
 * Какие предупреждения мини-поездки относятся к самому занятию. Длительность
 * поездки, зоны и резерв — про мини-поездку на три дня, а не про план
 * человека, и в ответ не идут.
 */
const DAY_WARNING_TYPES: ReadonlySet<string> = new Set([
  'safety', 'license', 'mchs', 'permit', 'season', 'fitness', 'border', 'seasickness', 'weather',
]);

/** Подбор нового дня — `recommendTrip`; параметром, чтобы сторож мог подменить хранилище. */
export interface EditDeps {
  recommend: (profile: TripProfile) => Promise<TripRecommendation>;
}

const DEFAULT_DEPS: EditDeps = {
  recommend: (profile) => recommendTrip(profile, { itinerary: 'plain' }),
};

/** Короче трёх дней план не бывает — тот же порог, что у make_trip_plan. */
const MIN_TRIP_DAYS = 3;
/** Длиннее 21 дня — тоже (readPlanDays). */
const MAX_TRIP_DAYS = 21;

/** Дни, которые правка двигает и убирает. Прилёт, отъезд и переезд — каркас поездки. */
const MOVABLE: ReadonlySet<DayPlan['type']> = new Set(['activity', 'rest', 'buffer']);

const LODGING_LABEL: Record<BudgetTier, string> = { economy: 'эконом', comfort: 'комфорт', premium: 'премиум' };

export function planProfile(params: PlanParams): TripProfile {
  return {
    interests: params.interests,
    arrivalDate: params.arrivalDate,
    departureDate: params.departureDate,
    adults: params.adults,
    children: params.children,
    fitnessLevel: 'moderate',
    budgetTier: params.budgetTier,
    riskMode: 'safe_only',
    ...(params.travelStyle ? { travelStyle: params.travelStyle } : {}),
    ...(params.restDays !== undefined ? { restDays: params.restDays } : {}),
  };
}

export function planPrice(plan: EditablePlan): PriceBreakdown {
  return calculatePriceBreakdown(plan.days, planProfile(plan.params));
}

function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function tripLength(params: PlanParams): number {
  return Math.round((Date.parse(`${params.departureDate}T00:00:00Z`) - Date.parse(`${params.arrivalDate}T00:00:00Z`)) / 86400000) + 1;
}

/** Дни одного многодневного тура идут вместе: убрать или сдвинуть часть нельзя. */
function tourGroup(days: readonly DayPlan[], day: DayPlan): DayPlan[] {
  const id = day.realTour?.tourId;
  if (!id) return [day];
  return days.filter((d) => d.realTour?.tourId === id);
}

function dayList(days: readonly DayPlan[]): string {
  const nums = days.map((d) => d.day);
  return nums.length > 0 ? `1–${Math.max(...nums)}` : 'нет';
}

function clone(plan: EditablePlan): EditablePlan {
  return JSON.parse(JSON.stringify(plan)) as EditablePlan;
}

/** Убрать день (или все дни многодневного тура). Поездка короче, дни после — на место раньше. */
function removeDay(plan: EditablePlan, num: number): EditResult {
  const target = plan.days.find((d) => d.day === num);
  if (!target) return { ok: false, reason: `Дня ${num} в плане нет (дни ${dayList(plan.days)}).` };
  if (!MOVABLE.has(target.type)) {
    return { ok: false, reason: `День ${num} — ${FRAME_WORD[target.type] ?? 'каркас поездки'}, его не убирают: без него поездка не сходится.` };
  }
  const group = tourGroup(plan.days, target);
  const removed = new Set(group.map((d) => d.day));
  if (tripLength(plan.params) - removed.size < MIN_TRIP_DAYS) {
    return { ok: false, reason: `После этого в поездке останется меньше ${MIN_TRIP_DAYS} дней — так план не собирается.` };
  }
  const next = clone(plan);
  const sorted = [...removed].sort((a, b) => a - b);
  next.days = next.days
    .filter((d) => !removed.has(d.day))
    .map((d) => ({ ...d, day: d.day - sorted.filter((r) => r < d.day).length }));
  next.params.departureDate = shiftIso(plan.params.departureDate, -removed.size);
  const what = group.length > 1
    ? `Убрал дни ${sorted.join(', ')} — это один многодневный тур, по частям его не убирают.`
    : `Убрал день ${num}.`;
  return { ok: true, plan: next, note: `${what} Поездка стала на ${removed.size} ${removed.size === 1 ? 'день' : 'дня'} короче, остальные дни не менялись.` };
}

const FRAME_WORD: Partial<Record<DayPlan['type'], string>> = {
  arrival: 'день прилёта', departure: 'день отъезда', travel: 'переезд между зонами',
};

/**
 * Переставить день на другое место. Двигаются только дни одной зоны: день
 * в чужой зоне потребовал бы переездов, которых в плане нет. Пустые
 * календарные дни («не заполнен») двигаются вместе со всеми.
 */
function moveDay(plan: EditablePlan, from: number, to: number): EditResult {
  if (from === to) return { ok: false, reason: `День ${from} уже на этом месте.` };
  const target = plan.days.find((d) => d.day === from);
  if (!target) return { ok: false, reason: `Дня ${from} в плане нет (дни ${dayList(plan.days)}).` };
  if (!MOVABLE.has(target.type)) {
    return { ok: false, reason: `День ${from} — ${FRAME_WORD[target.type] ?? 'каркас поездки'}, его не переставляют.` };
  }
  if (tourGroup(plan.days, target).length > 1) {
    return { ok: false, reason: `День ${from} — часть многодневного тура, по одному дню его не переставляют.` };
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const byNum = new Map(plan.days.map((d) => [d.day, d] as const));
  for (let n = lo; n <= hi; n++) {
    const d = byNum.get(n);
    if (!d) continue;
    if (!MOVABLE.has(d.type)) {
      return { ok: false, reason: `Между днями ${from} и ${to} стоит ${FRAME_WORD[d.type] ?? 'каркас поездки'} (день ${n}) — через него день не переносят.` };
    }
    if (d.zone !== target.zone) {
      return { ok: false, reason: `День ${n} в другой зоне — перенос потребовал бы переездов, которых в плане нет.` };
    }
    if (n !== from && tourGroup(plan.days, d).length > 1) {
      const group = tourGroup(plan.days, d).map((g) => g.day);
      const inside = to > Math.min(...group) && to <= Math.max(...group);
      if (inside) return { ok: false, reason: `На место ${to} нельзя: там идёт многодневный тур (дни ${group.join(', ')}), его не разрывают.` };
    }
  }
  // Слоты lo..hi, пустые календарные дни — тоже слоты.
  const slots: Array<DayPlan | null> = [];
  for (let n = lo; n <= hi; n++) slots.push(byNum.get(n) ?? null);
  const [moving] = slots.splice(from - lo, 1);
  slots.splice(to - lo, 0, moving);
  const next = clone(plan);
  const moved = new Map<DayPlan, number>();
  slots.forEach((d, i) => { if (d) moved.set(d, lo + i); });
  next.days = plan.days
    .map((d) => (moved.has(d) ? { ...d, day: moved.get(d) as number } : { ...d }))
    .sort((a, b) => a.day - b.day);
  return { ok: true, plan: next, note: `Переставил день ${from} на место ${to}. Дни вне этого отрезка не менялись.` };
}

/**
 * Добавить день по интересу. День подбирает движок мини-поездкой на один
 * активный день в ту же дату, с той же группой и тем же жильём; встаёт он
 * перед отъездом, поездка удлиняется на день. Чего движок не подобрал —
 * того не придумываем: отказ с его же причиной.
 */
async function addDay(plan: EditablePlan, interest: string, deps: EditDeps): Promise<EditResult> {
  const c = ACTIVITY_CONSTRAINTS[interest];
  const name = ACTIVITY_NAMES[interest] ?? interest;
  if (!c) return { ok: false, reason: `Интерес «${interest}» планер не знает.` };
  if (tripLength(plan.params) + 1 > MAX_TRIP_DAYS) {
    return { ok: false, reason: `Поездка уже ${tripLength(plan.params)} дней — длиннее ${MAX_TRIP_DAYS} план не собирается.` };
  }
  const youngest = plan.params.children.length > 0 ? Math.min(...plan.params.children) : null;
  const { blocked } = splitByChildAge([interest], youngest);
  if (blocked.length > 0) {
    const b = blocked[0];
    return { ok: false, reason: `${name}: с ${b.minAge} лет, младшему ${b.youngest} — в план семьи не ставим.${b.alternative ? ` Альтернатива: ${b.alternative}.` : ''}` };
  }

  const departure = plan.days.find((d) => d.type === 'departure');
  // Новый день встаёт на место отъезда (или в конец, если отъезда нет — у
  // местного жителя), отъезд — на день позже.
  const insertAt = departure ? departure.day : Math.max(0, ...plan.days.map((d) => d.day)) + 1;
  const newDate = shiftIso(plan.params.arrivalDate, insertAt - 1);
  const mini = await deps.recommend(planProfile({
    ...plan.params,
    interests: [interest],
    arrivalDate: shiftIso(newDate, -1),
    departureDate: shiftIso(newDate, 1),
    restDays: 0,
  }));
  const picked = mini.days.find((d) => d.type === 'activity' && d.activityType === interest);
  if (!picked) {
    const why = mini.warnings.find((w) => w.message.toLowerCase().includes(name.toLowerCase()));
    return {
      ok: false,
      reason: `День «${name}» на ${newDate.slice(8, 10)}.${newDate.slice(5, 7)} не собрался${why ? `: ${why.message}` : ' — подходящего выхода у нас нет'}. Придумывать день не стали.`,
    };
  }
  const next = clone(plan);
  next.days = [
    ...next.days.map((d) => (d.day >= insertAt ? { ...d, day: d.day + 1 } : d)),
    { ...picked, day: insertAt },
  ].sort((a, b) => a.day - b.day);
  next.params.departureDate = shiftIso(plan.params.departureDate, 1);
  if (!next.params.interests.includes(interest)) next.params.interests.push(interest);
  return {
    ok: true, plan: next,
    note: `Добавил день ${insertAt}: ${picked.title}. Поездка стала на день длиннее, остальные дни не менялись.`,
    warnings: mini.warnings.filter((w) => DAY_WARNING_TYPES.has(w.type)).map((w) => w.message),
  };
}

function setLodging(plan: EditablePlan, tier: BudgetTier): EditResult {
  if (plan.params.budgetTier === tier) {
    return { ok: false, reason: `Уровень жилья уже «${LODGING_LABEL[tier]}».` };
  }
  const next = clone(plan);
  next.params.budgetTier = tier;
  return { ok: true, plan: next, note: `Уровень жилья — «${LODGING_LABEL[tier]}». Дни не менялись, пересчитана оценка жилья.` };
}

/** Единственная точка правки плана: Кузьмич, MCP и (следующим шагом) веб-планер. */
export async function applyPlanEdit(plan: EditablePlan, edit: PlanEdit, deps: EditDeps = DEFAULT_DEPS): Promise<EditResult> {
  switch (edit.kind) {
    case 'remove_day': return removeDay(plan, edit.day);
    case 'move_day': return moveDay(plan, edit.day, edit.to);
    case 'add_day': return addDay(plan, edit.interest, deps);
    case 'set_lodging': return setLodging(plan, edit.tier);
  }
}
