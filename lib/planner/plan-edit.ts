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
 *
 * Аудит планировщика 07.11 (M3, M4):
 *  - правки «нас трое» (`set_party`), «сдвинь поездку» (`shift_dates`) и
 *    «замени вулкан» (`replace_day`) — правкой, а не новым планом с новым ID
 *    и потерей прежних правок;
 *  - правка, которая ставит тур на другую дату или другой группе, перечитывает
 *    его места и цену (lib/planner/tour-day-reread), а сдвиг дат — строки
 *    парков и МЧС (lib/planner/plan-safety-refresh). Раньше места и цена
 *    оставались от прежней даты, а ответ говорил «остальные дни не менялись».
 */

import {
  recommendTrip, calculatePriceBreakdown, splitByChildAge,
  type DayPlan, type TripProfile, type BudgetTier, type PriceBreakdown, type TripRecommendation,
} from './engine';
import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES, ZONE_NAMES, type FitnessLevel } from './constants';
import { estimateGroup, type GroupEstimate } from './estimate';
import type { TravelStyle } from './travel-style';
import { MOVABLE_TYPES as MOVABLE, FRAME_WORD, tourGroup, insertIndex } from './plan-ops';
import { dateOfTripDay } from './flow-balance';
import { rereadTourDay, type TourDayInput, type TourDayRead } from './tour-day-reread';
import { refreshDatedSafety, DEFAULT_SAFETY_DEPS, type SafetyRefreshDeps } from './plan-safety-refresh';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';

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
  /**
   * Ограничения группы (#2226): план, собранный из пожеланий участников,
   * правится с теми же ограничениями. Не записано — как у одиночного плана.
   */
  fitnessLevel?: FitnessLevel;
  seasickness?: boolean;
  mobilityLevel?: 'full' | 'limited';
}

export interface EditablePlan {
  params: PlanParams;
  days: DayPlan[];
}

export type PlanEdit =
  | { kind: 'add_day'; interest: string }
  | { kind: 'remove_day'; day: number }
  | { kind: 'move_day'; day: number; to: number }
  | { kind: 'set_lodging'; tier: BudgetTier }
  /**
   * Рейс задержан на `days` дней (#2231, решение владельца 08.10: сигнал даёт
   * сам турист). `keepReturn` — обратный билет не меняется: поездка короче,
   * выпадают дни сразу после прилёта. Иначе вся поездка сдвигается целиком.
   */
  | { kind: 'flight_delay'; days: number; keepReturn: boolean }
  /**
   * Состав группы (M4): взрослые и возраст каждого ребёнка. Не названо —
   * прежнее. Дни те же; места и цена туров перечитываются на новую группу,
   * смета считается на неё.
   */
  | { kind: 'set_party'; adults?: number; children?: number[] }
  /**
   * Сдвиг всей поездки (M4): те же дни в том же порядке, та же длина, новые
   * даты. `startDate` — новый первый день, YYYY-MM-DD; `length` — длина
   * названного диапазона («20–27 июля»), если он назван: сдвиг длину не
   * меняет, и разная длина — отказ, а не половина диапазона.
   */
  | { kind: 'shift_dates'; startDate: string; length?: number }
  /** Сдвиг всей поездки на `days` дней: больше нуля — позже, меньше — раньше. */
  | { kind: 'shift_dates'; days: number }
  /** Замена дня (M4): на дату дня `day` — занятие `interest`, остальные дни не меняются. */
  | { kind: 'replace_day'; day: number; interest: string };

/** Тур оператора, которого правка коснулась. */
export interface TouchedTour {
  tourId: string;
  title: string;
  /** Выпал из плана, попал на другие даты или идёт другой группой. */
  how: 'dropped' | 'shifted' | 'party';
}

/** Что показало перечитывание мест тура на его новую дату или группу (M3). */
export interface RereadTour {
  tourId: string;
  title: string;
  day: number;
  /** Дата дня плана, YYYY-MM-DD. */
  date: string;
  availability: TourDayRead['availability'];
  slotsRemaining?: number;
}

export type EditResult =
  | {
    ok: true; plan: EditablePlan; note: string;
    /**
     * Туры операторов, которых правка коснулась: выпали из плана, уехали на
     * другие даты или идут другой группой. Если тур уже забронирован,
     * оператору надо сказать — сам план брони не меняет.
     */
    toursTouched?: TouchedTour[];
    /**
     * Предупреждения о добавленном занятии (безопасность, разрешения, сезон,
     * подготовка) и о новых датах (закрытие парков, сводка МЧС). Без них
     * «добавь день рыбалки» потерял бы «нужна путёвка» и «территория
     * медведей», которые сказал бы полный план.
     */
    warnings?: string[];
    /**
     * Туры, чьи места и цену правка перечитала на новую дату или группу (M3).
     * Нет поля — перечитывать было нечего.
     */
    reread?: RereadTour[];
  }
  | { ok: false; reason: string };

type EditDone = Extract<EditResult, { ok: true }>;

/**
 * Итог операции до перечитывания: что сменило дату и сменилась ли группа.
 * `moved` — номера дней нового плана, чья дата сменилась.
 */
type Applied =
  | (Omit<EditDone, 'reread'> & { moved: number[]; regroup?: boolean })
  | { ok: false; reason: string };

/**
 * Какие предупреждения мини-поездки относятся к самому занятию. Длительность
 * поездки, зоны и резерв — про мини-поездку на три дня, а не про план
 * человека, и в ответ не идут.
 */
const DAY_WARNING_TYPES: ReadonlySet<string> = new Set([
  'safety', 'license', 'mchs', 'permit', 'season', 'fitness', 'border', 'seasickness', 'weather',
]);

/**
 * Зависимости правки — параметром, чтобы сторож мог подменить хранилище.
 * Подбор нового дня — `recommendTrip`; места и цена тура на дату —
 * `rereadTourDay`; строки парков и МЧС — `refreshDatedSafety`; «сегодня» —
 * по Камчатке.
 */
export interface EditDeps {
  recommend: (profile: TripProfile) => Promise<TripRecommendation>;
  reread?: (input: TourDayInput) => Promise<TourDayRead>;
  safety?: SafetyRefreshDeps;
  /** Сегодня по Камчатке, YYYY-MM-DD. */
  today?: () => string;
}

const DEFAULT_DEPS: EditDeps = {
  recommend: (profile) => recommendTrip(profile, { itinerary: 'plain' }),
};

/** Короче трёх дней план не бывает — тот же порог, что у make_trip_plan. */
const MIN_TRIP_DAYS = 3;
/** Длиннее 21 дня — тоже (readPlanDays). */
const MAX_TRIP_DAYS = 21;
/** Группа — до 30 человек, как у заявки на бронь и у make_trip_plan. */
export const MAX_PARTY = 30;
/** Сдвиг поездки дальше года — это уже другая поездка. */
export const MAX_SHIFT_DAYS = 365;

const LODGING_LABEL: Record<BudgetTier, string> = { economy: 'эконом', comfort: 'комфорт', premium: 'премиум' };

const MONTH_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_LOCATIVE = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

export function planProfile(params: PlanParams): TripProfile {
  return {
    interests: params.interests,
    arrivalDate: params.arrivalDate,
    departureDate: params.departureDate,
    adults: params.adults,
    children: params.children,
    fitnessLevel: params.fitnessLevel ?? 'moderate',
    budgetTier: params.budgetTier,
    riskMode: 'safe_only',
    ...(params.seasickness ? { seasickness: true } : {}),
    ...(params.mobilityLevel ? { mobilityLevel: params.mobilityLevel } : {}),
    ...(params.travelStyle ? { travelStyle: params.travelStyle } : {}),
    ...(params.restDays !== undefined ? { restDays: params.restDays } : {}),
  };
}

export function planPrice(plan: EditablePlan): PriceBreakdown {
  return calculatePriceBreakdown(plan.days, planProfile(plan.params));
}

/** Смета плана на группу (#2304) — та же формула, что у экрана /planner. */
export function planEstimate(plan: EditablePlan): GroupEstimate {
  const p = planProfile(plan.params);
  return estimateGroup(plan.days, { adults: p.adults, children: p.children, budgetTier: p.budgetTier, tripOrigin: p.tripOrigin });
}

function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function tripLength(params: PlanParams): number {
  return daysBetween(params.arrivalDate, params.departureDate) + 1;
}

function dayList(days: readonly DayPlan[]): string {
  const nums = days.map((d) => d.day);
  return nums.length > 0 ? `1–${Math.max(...nums)}` : 'нет';
}

function clone(plan: EditablePlan): EditablePlan {
  return JSON.parse(JSON.stringify(plan)) as EditablePlan;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function dayWordFor(n: number): string {
  return plural(n, 'день', 'дня', 'дней');
}

function tourTitle(d: DayPlan): string {
  return d.title.replace(/\s*\(день \d+ из \d+\)\s*$/, '').replace(/\s+—\s+день \d+ из \d+$/, '');
}

/** Туры дней из списка — по одному на тур, в порядке плана. */
function toursOf(days: readonly DayPlan[], how: TouchedTour['how']): TouchedTour[] {
  const seen = new Map<string, TouchedTour>();
  for (const d of days) {
    const id = d.realTour?.tourId;
    if (id && !seen.has(id)) seen.set(id, { tourId: id, title: tourTitle(d), how });
  }
  return [...seen.values()];
}

/** Перенос номеров дней: что сменило место, то сменило и дату (прилёт тот же). */
function renumberedDays(next: readonly DayPlan[], oldNumberOf: ReadonlyMap<DayPlan, number>): number[] {
  return next.filter((d) => oldNumberOf.has(d) && oldNumberOf.get(d) !== d.day).map((d) => d.day);
}

/** Убрать день (или все дни многодневного тура). Поездка короче, дни после — на место раньше. */
function removeDay(plan: EditablePlan, num: number): Applied {
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
  const oldNumber = new Map<DayPlan, number>();
  next.days = next.days
    .filter((d) => !removed.has(d.day))
    .map((d) => {
      const shifted = { ...d, day: d.day - sorted.filter((r) => r < d.day).length };
      oldNumber.set(shifted, d.day);
      return shifted;
    });
  next.params.departureDate = shiftIso(plan.params.departureDate, -removed.size);
  const moved = renumberedDays(next.days, oldNumber);
  const what = group.length > 1
    ? `Убрал дни ${sorted.join(', ')} — это один многодневный тур, по частям его не убирают.`
    : `Убрал день ${num}.`;
  const after = moved.length > 0
    ? ` Дни после него встали на ${removed.size === 1 ? 'день' : `${removed.size} ${dayWordFor(removed.size)}`} раньше — у их туров новые даты.`
    : '';
  return {
    ok: true, plan: next, moved,
    note: `${what} Поездка стала на ${removed.size} ${dayWordFor(removed.size)} короче.${after}`,
    toursTouched: [
      ...toursOf(group, 'dropped'),
      ...toursOf(next.days.filter((d) => moved.includes(d.day)), 'shifted'),
    ],
  };
}

/**
 * Переставить день на другое место. Двигаются только дни одной зоны: день
 * в чужой зоне потребовал бы переездов, которых в плане нет. Пустые
 * календарные дни («не заполнен») двигаются вместе со всеми.
 */
function moveDay(plan: EditablePlan, from: number, to: number): Applied {
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
  const oldNumber = new Map<DayPlan, number>();
  next.days = plan.days
    .map((d) => {
      const copy = moved.has(d) ? { ...d, day: moved.get(d) as number } : { ...d };
      oldNumber.set(copy, d.day);
      return copy;
    })
    .sort((a, b) => a.day - b.day);
  const changed = renumberedDays(next.days, oldNumber);
  const tours = toursOf(next.days.filter((d) => changed.includes(d.day)), 'shifted');
  return {
    ok: true, plan: next, moved: changed,
    note: `Переставил день ${from} на место ${to}. Дни вне этого отрезка не менялись${tours.length > 0 ? '; у туров внутри отрезка новые даты' : ''}.`,
    toursTouched: tours,
  };
}

/**
 * Подобрать занятие на одну дату: мини-поездка движка на три дня (прилёт,
 * занятие, отъезд) той же группой и тем же жильём. Чего движок не подобрал —
 * того не придумываем: отказ с его же причиной.
 */
async function pickDay(
  plan: EditablePlan, interest: string, dateIso: string, deps: EditDeps,
): Promise<{ ok: true; day: DayPlan; warnings: string[] } | { ok: false; reason: string }> {
  const name = ACTIVITY_NAMES[interest] ?? interest;
  const mini = await deps.recommend(planProfile({
    ...plan.params,
    interests: [interest],
    arrivalDate: shiftIso(dateIso, -1),
    departureDate: shiftIso(dateIso, 1),
    restDays: 0,
  }));
  const picked = mini.days.find((d) => d.type === 'activity' && d.activityType === interest);
  if (!picked) {
    const why = mini.warnings.find((w) => w.message.toLowerCase().includes(name.toLowerCase()));
    return {
      ok: false,
      reason: `День «${name}» на ${dateIso.slice(8, 10)}.${dateIso.slice(5, 7)} не собрался${why ? `: ${why.message}` : ' — подходящего выхода у нас нет'}. Придумывать день не стали.`,
    };
  }
  return { ok: true, day: picked, warnings: mini.warnings.filter((w) => DAY_WARNING_TYPES.has(w.type)).map((w) => w.message) };
}

/** Занятие не по возрасту младшего — в план семьи не ставим. null — можно. */
function childAgeRefusal(interest: string, children: readonly number[]): string | null {
  const youngest = children.length > 0 ? Math.min(...children) : null;
  const { blocked } = splitByChildAge([interest], youngest);
  if (blocked.length === 0) return null;
  const b = blocked[0];
  const name = ACTIVITY_NAMES[interest] ?? interest;
  return `${name}: с ${b.minAge} лет, младшему ${b.youngest} — в план семьи не ставим.${b.alternative ? ` Альтернатива: ${b.alternative}.` : ''}`;
}

/**
 * Добавить день по интересу. День подбирает движок мини-поездкой на один
 * активный день в ту же дату, с той же группой и тем же жильём; встаёт он
 * перед отъездом, поездка удлиняется на день.
 */
async function addDay(plan: EditablePlan, interest: string, deps: EditDeps): Promise<Applied> {
  const c = ACTIVITY_CONSTRAINTS[interest];
  if (!c) return { ok: false, reason: `Интерес «${interest}» планер не знает.` };
  if (tripLength(plan.params) + 1 > MAX_TRIP_DAYS) {
    return { ok: false, reason: `Поездка уже ${tripLength(plan.params)} дней — длиннее ${MAX_TRIP_DAYS} план не собирается.` };
  }
  const tooYoung = childAgeRefusal(interest, plan.params.children);
  if (tooYoung) return { ok: false, reason: tooYoung };

  // Новый день встаёт на место отъезда (или в конец, если отъезда нет — у
  // местного жителя), отъезд — на день позже. Место — общим правилом
  // plan-ops, тем же, что у кнопок веб-планера.
  const at = insertIndex(plan.days);
  const insertAt = at < plan.days.length ? plan.days[at].day : Math.max(0, ...plan.days.map((d) => d.day)) + 1;
  const newDate = shiftIso(plan.params.arrivalDate, insertAt - 1);
  const pick = await pickDay(plan, interest, newDate, deps);
  if (!pick.ok) return pick;
  const next = clone(plan);
  const shifted = next.days.filter((d) => d.day >= insertAt).map((d) => d.day + 1);
  next.days = [
    ...next.days.map((d) => (d.day >= insertAt ? { ...d, day: d.day + 1 } : d)),
    { ...pick.day, day: insertAt },
  ].sort((a, b) => a.day - b.day);
  next.params.departureDate = shiftIso(plan.params.departureDate, 1);
  if (!next.params.interests.includes(interest)) next.params.interests.push(interest);
  return {
    ok: true, plan: next, moved: shifted,
    note: `Добавил день ${insertAt}: ${pick.day.title}. Поездка стала на день длиннее, остальные дни не менялись.`,
    warnings: pick.warnings,
    toursTouched: toursOf(next.days.filter((d) => shifted.includes(d.day)), 'shifted'),
  };
}

/**
 * Заменить день (M4): на дату дня — другое занятие, подобранное движком той
 * же мини-поездкой, что у add_day. Каркас поездки и день многодневного тура
 * не заменяют (то же правило, что у кнопок веб-планера, plan-ops). Занятие
 * нашлось только в другой зоне — отказ: замена потребовала бы переездов,
 * которых в плане нет.
 */
async function replaceDay(plan: EditablePlan, num: number, interest: string, deps: EditDeps): Promise<Applied> {
  const target = plan.days.find((d) => d.day === num);
  if (!target) return { ok: false, reason: `Дня ${num} в плане нет (дни ${dayList(plan.days)}).` };
  if (!MOVABLE.has(target.type)) {
    return { ok: false, reason: `День ${num} — ${FRAME_WORD[target.type] ?? 'каркас поездки'}, его не заменяют: без него поездка не сходится.` };
  }
  if (tourGroup(plan.days, target).length > 1) {
    return { ok: false, reason: `День ${num} — часть многодневного тура, по одному дню его не заменяют. Убери тур целиком (remove_day) и добавь день (add_day).` };
  }
  const c = ACTIVITY_CONSTRAINTS[interest];
  const name = ACTIVITY_NAMES[interest] ?? interest;
  if (!c) return { ok: false, reason: `Интерес «${interest}» планер не знает.` };
  if (target.type === 'activity' && target.activityType === interest) {
    return { ok: false, reason: `День ${num} уже «${name}».` };
  }
  const tooYoung = childAgeRefusal(interest, plan.params.children);
  if (tooYoung) return { ok: false, reason: tooYoung };

  const dateIso = shiftIso(plan.params.arrivalDate, num - 1);
  const pick = await pickDay(plan, interest, dateIso, deps);
  if (!pick.ok) return pick;
  if (pick.day.zone !== target.zone) {
    return {
      ok: false,
      reason: `«${name}» на ${dateIso.slice(8, 10)}.${dateIso.slice(5, 7)} нашлось только в зоне «${ZONE_NAMES[pick.day.zone]}», а день ${num} — в зоне «${ZONE_NAMES[target.zone]}»: замена потребовала бы переездов, которых в плане нет. Можно добавить день (add_day) — он встанет перед отъездом.`,
    };
  }
  const next = clone(plan);
  next.days = next.days.map((d) => (d.day === num ? { ...pick.day, day: num } : d));
  if (!next.params.interests.includes(interest)) next.params.interests.push(interest);
  return {
    ok: true, plan: next, moved: [],
    note: `Заменил день ${num} (${dateWords(dateIso)}): было «${tourTitle(target)}», стало «${pick.day.title}». Остальные дни не менялись.`
      // Резерв на нелётную погоду — запас безопасности; занят — сказано.
      + (target.type === 'buffer' ? ' Резерва на нелётную погоду в плане больше нет.' : ''),
    warnings: pick.warnings,
    toursTouched: toursOf([target], 'dropped'),
  };
}

function setLodging(plan: EditablePlan, tier: BudgetTier): Applied {
  if (plan.params.budgetTier === tier) {
    return { ok: false, reason: `Уровень жилья уже «${LODGING_LABEL[tier]}».` };
  }
  const next = clone(plan);
  next.params.budgetTier = tier;
  return { ok: true, plan: next, moved: [], note: `Уровень жилья — «${LODGING_LABEL[tier]}». Дни не менялись, пересчитана оценка жилья.` };
}

/** «до года», «1 год», «6 лет». */
function ageWords(n: number): string {
  return n === 0 ? 'до года' : `${n} ${plural(n, 'год', 'года', 'лет')}`;
}

/** «2 взрослых», «3 взрослых и ребёнок (6 лет)», «2 взрослых и дети (6 лет, 10 лет)». */
export function partyWords(adults: number, children: readonly number[]): string {
  const a = `${adults} ${plural(adults, 'взрослый', 'взрослых', 'взрослых')}`;
  if (children.length === 0) return `${a}, без детей`;
  const ages = children.map(ageWords).join(', ');
  return children.length === 1 ? `${a} и ребёнок (${ages})` : `${a} и дети (${ages})`;
}

function sameAges(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

/**
 * Состав группы (M4). Дни те же. Занятие, которое младшему не по возрасту, в
 * плане семьи не остаётся: правка — отказ с днями и подсказкой, что сделать
 * сначала. Места и цена туров — на новую группу (перечитываются после).
 */
function setParty(plan: EditablePlan, adults: number, children: readonly number[]): Applied {
  if (!Number.isInteger(adults) || adults < 1 || adults > MAX_PARTY) {
    return { ok: false, reason: `Взрослых — от 1 до ${MAX_PARTY}.` };
  }
  if (adults + children.length > MAX_PARTY) {
    return { ok: false, reason: `Группа — не больше ${MAX_PARTY} человек, а вышло ${adults + children.length}.` };
  }
  if (adults === plan.params.adults && sameAges(children, plan.params.children)) {
    return { ok: false, reason: `Состав уже такой: ${partyWords(adults, children)}.` };
  }
  const youngest = children.length > 0 ? Math.min(...children) : null;
  const blockedDays = new Map<string, { days: number[]; minAge: number; alternative: string | null }>();
  for (const d of plan.days) {
    if (d.type !== 'activity') continue;
    const b = splitByChildAge([d.activityType], youngest).blocked[0];
    if (!b) continue;
    const entry = blockedDays.get(d.activityType) ?? { days: [], minAge: b.minAge, alternative: b.alternative };
    entry.days.push(d.day);
    blockedDays.set(d.activityType, entry);
  }
  if (blockedDays.size > 0) {
    const lines = [...blockedDays.entries()].map(([interest, e]) =>
      `${ACTIVITY_NAMES[interest] ?? interest} (${e.days.length === 1 ? `день ${e.days[0]}` : `дни ${e.days.join(', ')}`}) — с ${e.minAge} лет${e.alternative ? `; альтернатива: ${e.alternative}` : ''}`);
    return {
      ok: false,
      reason: `Младшему ${youngest} — в плане есть занятия не по возрасту: ${lines.join('; ')}. Сначала замени эти дни (replace_day) или убери их (remove_day), потом меняй состав.`,
    };
  }
  const next = clone(plan);
  next.params.adults = adults;
  next.params.children = [...children];
  return {
    ok: true, plan: next, moved: [], regroup: true,
    note: `Состав группы: ${partyWords(adults, children)} (было: ${partyWords(plan.params.adults, plan.params.children)}). Дни те же, смета посчитана на новый состав.`,
    toursTouched: toursOf(next.days, 'party'),
  };
}

/** «12 октября» — дата словами, по UTC, как и все даты плана. */
function dateWords(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_GENITIVE[m - 1]}`;
}

/** «в июне–сентябре», «в июле». */
function monthsWords(months: readonly number[]): string {
  const sorted = [...months].sort((a, b) => a - b);
  if (sorted.length === 0) return 'нет';
  if (sorted.length === 1) return `в ${MONTH_LOCATIVE[sorted[0] - 1]}`;
  const contiguous = sorted.every((m, i) => i === 0 || m === sorted[i - 1] + 1);
  return contiguous
    ? `в ${MONTH_LOCATIVE[sorted[0] - 1]}–${MONTH_LOCATIVE[sorted[sorted.length - 1] - 1]}`
    : `в ${sorted.map((m) => MONTH_LOCATIVE[m - 1]).join(', ')}`;
}

/**
 * Сдвиг всей поездки (M4). Дни те же и в том же порядке. Нельзя:
 *  - в прошлое (по Камчатке) — поездку туда не перенести;
 *  - дальше года — это другая поездка, собирается заново;
 *  - туда, где занятие дня вне своего сезона, — правка не ставит в план то,
 *    чего в эти даты не бывает. Отказ называет дни и сезон.
 */
function shiftDates(plan: EditablePlan, edit: Extract<PlanEdit, { kind: 'shift_dates' }>, todayIso: string): Applied {
  const delta = 'startDate' in edit ? daysBetween(plan.params.arrivalDate, edit.startDate) : edit.days;
  if (!Number.isInteger(delta)) return { ok: false, reason: 'Сдвиг — целое число дней.' };
  const length = tripLength(plan.params);
  if ('startDate' in edit && edit.length !== undefined && edit.length !== length) {
    return {
      ok: false,
      reason: `Названы даты на ${edit.length} ${dayWordFor(edit.length)}, а поездка — ${length} ${dayWordFor(length)}: сдвиг длину не меняет. Сдвинь на начало этих дат, а дни добавь (add_day) или убери (remove_day) отдельно.`,
    };
  }
  if (delta === 0) return { ok: false, reason: `Поездка уже начинается ${dateWords(plan.params.arrivalDate)}.` };
  if (Math.abs(delta) > MAX_SHIFT_DAYS) {
    return { ok: false, reason: 'Сдвиг больше чем на год — это уже другая поездка: собери план заново через make_trip_plan.' };
  }
  const arrival = shiftIso(plan.params.arrivalDate, delta);
  const departure = shiftIso(plan.params.departureDate, delta);
  if (arrival < todayIso) {
    return { ok: false, reason: `${dateWords(arrival)} по Камчатке уже прошло — поездку туда не перенести. Назови дату не раньше сегодняшней.` };
  }
  const offSeason: string[] = [];
  for (const d of plan.days) {
    if (d.type !== 'activity') continue;
    const c = ACTIVITY_CONSTRAINTS[d.activityType];
    const iso = shiftIso(arrival, d.day - 1);
    if (!c || c.months.includes(Number(iso.slice(5, 7)))) continue;
    offSeason.push(`день ${d.day} — ${ACTIVITY_NAMES[d.activityType] ?? d.activityType}, ${dateWords(iso)}, а сезон ${monthsWords(c.months)}`);
  }
  if (offSeason.length > 0) {
    return {
      ok: false,
      reason: `В новые даты не сезон: ${offSeason.join('; ')}. Замени эти дни (replace_day) или убери их (remove_day) и сдвигай потом — или собери план заново на новые даты.`,
    };
  }
  const next = clone(plan);
  next.params.arrivalDate = arrival;
  next.params.departureDate = departure;
  const n = Math.abs(delta);
  return {
    ok: true, plan: next, moved: next.days.map((d) => d.day),
    note: `Поездка сдвинута на ${n} ${dayWordFor(n)} ${delta > 0 ? 'позже' : 'раньше'}: ${dateWords(arrival)} — ${dateWords(departure)}. Дни те же и в том же порядке.`,
    toursTouched: toursOf(next.days, 'shifted'),
  };
}

/** Максимум задержки, который правка разбирает; больше — пересборка плана. */
export const MAX_FLIGHT_DELAY_DAYS = 7;

/**
 * Рейс задержан (#2231). Прилёт уезжает на `days` дней позже.
 *
 * Обратный билет остаётся (`keepReturn`) — выпадают `days` дней сразу после
 * прилёта: это те дни, которые человек проведёт в ожидании рейса. Переезд
 * между зонами или отъезд в этом окне — отказ: план без них не сходится, и
 * честнее собрать его заново, чем подставить. Многодневный тур, задетый
 * окном хоть одним днём, выпадает целиком (по частям его не проходят), а
 * его оставшиеся дни становятся свободными.
 *
 * Обратный билет переносится — поездка сдвигается целиком, дни те же. Туры
 * операторов при этом попадают на другие даты, и их места и цена
 * перечитываются (M3).
 *
 * Брони план не меняет: задетые туры возвращаются списком, чтобы ответ
 * сказал человеку, кому из операторов написать.
 */
function flightDelay(plan: EditablePlan, days: number, keepReturn: boolean): Applied {
  if (!Number.isInteger(days) || days < 1) return { ok: false, reason: 'Задержка — целое число дней, от одного.' };
  if (days > MAX_FLIGHT_DELAY_DAYS) {
    return { ok: false, reason: `Задержка больше ${MAX_FLIGHT_DELAY_DAYS} дней — это уже другая поездка: собери план заново через make_trip_plan с новыми датами.` };
  }
  const dayWord = dayWordFor(days);

  if (!keepReturn) {
    const next = clone(plan);
    next.params.arrivalDate = shiftIso(plan.params.arrivalDate, days);
    next.params.departureDate = shiftIso(plan.params.departureDate, days);
    return {
      ok: true, plan: next, moved: next.days.map((d) => d.day),
      note: `Рейс задержан на ${days} ${dayWord}: вся поездка сдвинута, прилёт ${next.params.arrivalDate}, отъезд ${next.params.departureDate}. Дни те же, но туры операторов попали на другие даты.`,
      toursTouched: toursOf(plan.days, 'shifted'),
    };
  }

  if (tripLength(plan.params) - days < MIN_TRIP_DAYS) {
    return { ok: false, reason: `При обратном билете на прежнюю дату от поездки останется меньше ${MIN_TRIP_DAYS} дней — такой план не собирается. Можно сдвинуть всю поездку (обратный билет переносится) или собрать план заново.` };
  }
  const arrival = plan.days.find((d) => d.type === 'arrival');
  const start = arrival ? arrival.day + 1 : 1;
  const lost = plan.days.filter((d) => d.day >= start && d.day < start + days);
  const frame = lost.find((d) => !MOVABLE.has(d.type));
  if (frame) {
    return { ok: false, reason: `Задержка задевает ${FRAME_WORD[frame.type] ?? 'каркас поездки'} (день ${frame.day}) — без него план не сходится. Собери план заново через make_trip_plan с новой датой прилёта.` };
  }
  // Многодневный тур, задетый окном, выпадает целиком.
  const droppedTours = new Set(lost.map((d) => d.realTour?.tourId).filter((id): id is string => Boolean(id)));
  const removed = new Set<number>([
    ...lost.map((d) => d.day),
    ...plan.days.filter((d) => d.realTour?.tourId && droppedTours.has(d.realTour.tourId)).map((d) => d.day),
  ]);
  const next = clone(plan);
  next.days = next.days
    .filter((d) => !removed.has(d.day))
    // Окно [start, start+days) выпадает из календаря: дни после него — на
    // `days` раньше. Дни выпавшего тура за окном остаются пустыми.
    .map((d) => (d.day >= start + days ? { ...d, day: d.day - days } : d));
  next.params.arrivalDate = shiftIso(plan.params.arrivalDate, days);
  const dropped = plan.days.filter((d) => removed.has(d.day)).sort((a, b) => a.day - b.day);
  // Номера сдвигает окно задержки, а не выпавшие дни: окно могло прийтись
  // на незаполненные дни, и тогда не выпало ничего, а номера всё равно
  // сдвинулись. Поэтому граница называется датой последнего дня окна.
  const windowLastIso = shiftIso(plan.params.arrivalDate, start + days - 2);
  return {
    // Оставшиеся дни стоят на прежних датах: номер меньше на `days`, прилёт
    // позже на столько же. Перечитывать их места не нужно.
    ok: true, plan: next, moved: [],
    note: `Рейс задержан на ${days} ${dayWord}: прилёт теперь ${dateWords(next.params.arrivalDate)} (${next.params.arrivalDate}), обратный билет прежний — поездка стала на ${days} ${dayWord} короче. `
      + droppedDaysWords(dropped, plan.params.arrivalDate, next.params.arrivalDate, start + days)
      + ` ${dropped.length > 0 ? 'Остальные дни' : 'Дни плана'} не менялись и стоят на прежних датах — туры операторов идут по датам; номера дней после ${dateWords(windowLastIso)} стали на ${days} меньше.`,
    toursTouched: toursOf(plan.days.filter((d) => removed.has(d.day)), 'dropped'),
  };
}

/** «день 2 (11 июля, Термальные источники)» — номер, дата и что было в этот день. */
function dayWords(d: DayPlan, arrivalIso: string): string {
  return `${d.day} (${dateWords(shiftIso(arrivalIso, d.day - 1))}, ${tourTitle(d)})`;
}

/** «2 (…)», «2 (…) и 3 (…)», «2 (…), 3 (…) и 4 (…)». */
function joinDays(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/**
 * Какие дни выпали из-за задержки рейса — словами, с датой, занятием и
 * причиной (живая проверка MCP 22.10).
 *
 * Прежний ответ — «Выпали дни 2; остальные дни не менялись»: без числа
 * («выпал день»), без даты и без смысла. Агент не мог сказать человеку, что
 * пропали термальные источники и почему — а причина простая: дни плана
 * привязаны к датам (туры у операторов идут по датам), и на дату этого дня
 * теперь приходится прилёт.
 *
 * Причин три, и они разные: на эту дату теперь прилёт; в эту дату человек ещё
 * в пути (задержка больше дня); день — хвост многодневного тура, задетого
 * задержкой, тур выпадает целиком, а день остаётся свободным. `windowEnd` —
 * первый номер дня (по прежнему плану) после окна задержки.
 */
function droppedDaysWords(
  dropped: readonly DayPlan[], oldArrivalIso: string, newArrivalIso: string, windowEnd: number,
): string {
  const inWindow = dropped.filter((d) => d.day < windowEnd);
  const tail = dropped.filter((d) => d.day >= windowEnd);
  const parts: string[] = [];
  if (inWindow.length > 0) {
    const iso = (d: DayPlan) => shiftIso(oldArrivalIso, d.day - 1);
    const onArrival = inWindow.some((d) => iso(d) === newArrivalIso);
    const inTransit = inWindow.some((d) => iso(d) < newArrivalIso);
    const one = inWindow.length === 1;
    const arrivalWords = dateWords(newArrivalIso);
    const why = onArrival && !inTransit
      ? (one ? 'в этот день теперь прилёт' : 'в эти дни теперь прилёт')
      : !onArrival
        ? `${one ? 'в этот день' : 'в эти дни'} вы ещё в пути — прилёт теперь ${arrivalWords}`
        : `до ${arrivalWords} вы ещё в пути, ${arrivalWords} — прилёт`;
    parts.push(`${one ? 'День' : 'Дни'} ${joinDays(inWindow.map((d) => dayWords(d, oldArrivalIso)))} ${one ? 'выпал' : 'выпали'}: ${why}.`);
  }
  if (tail.length > 0) {
    const one = tail.length === 1;
    parts.push(`${one ? 'День' : 'Дни'} ${joinDays(tail.map((d) => dayWords(d, oldArrivalIso)))} тоже ${one ? 'выпал' : 'выпали'}: многодневный тур выпадает целиком, по частям его не проходят, — ${one ? 'этот день теперь свободен' : 'эти дни теперь свободны'}.`);
  }
  // Окно пришлось на незаполненные дни — выпадать было нечему, и это сказано.
  return parts.length > 0 ? parts.join(' ') : 'Занятий на эти даты в плане не было — ничего не выпало.';
}

/**
 * Перечитать места и цену туров на днях `dayNums` (новые номера) — на их
 * дату и группу плана. Места и цену несёт только первый день тура: у
 * продолжения многодневного их нет (как у движка), поэтому для дня
 * продолжения перечитывается начало его тура.
 */
async function rereadTours(
  plan: EditablePlan, dayNums: readonly number[], read: (input: TourDayInput) => Promise<TourDayRead>,
): Promise<RereadTour[]> {
  const byNum = new Map(plan.days.map((d) => [d.day, d] as const));
  /** Начало тура дня: назад, пока вчера тот же тур. */
  const startOf = (day: DayPlan): DayPlan => {
    const prev = byNum.get(day.day - 1);
    return prev && prev.realTour?.tourId === day.realTour?.tourId ? startOf(prev) : day;
  };
  const starts = new Set<DayPlan>();
  for (const n of dayNums) {
    const d = byNum.get(n);
    if (d?.realTour) starts.add(startOf(d));
  }
  const people = plan.params.adults + plan.params.children.length;
  const ordered = [...starts].sort((a, b) => a.day - b.day);
  return Promise.all(ordered.map(async (d) => {
    const tour = d.realTour as NonNullable<DayPlan['realTour']>;
    const date = dateOfTripDay(plan.params.arrivalDate, d.day) as string;
    const r = await read({ tourId: tour.tourId, maxParticipants: tour.maxParticipants, date, participants: people });
    d.availability = r.availability;
    d.priceFrom = r.priceFrom;
    d.priceTo = r.priceTo;
    delete d.availableDate;
    delete d.slotsRemaining;
    delete d.capacityWarning;
    delete d.realPrice;
    delete d.priceMissing;
    if (r.availableDate !== undefined) d.availableDate = r.availableDate;
    if (r.slotsRemaining !== undefined) d.slotsRemaining = r.slotsRemaining;
    if (r.capacityWarning !== undefined) d.capacityWarning = r.capacityWarning;
    if (r.realPrice !== undefined) d.realPrice = r.realPrice;
    if (r.priceMissing !== undefined) d.priceMissing = r.priceMissing;
    if (r.priceLabel !== undefined) tour.priceLabel = r.priceLabel;
    else delete tour.priceLabel;
    return {
      tourId: tour.tourId, title: tourTitle(d), day: d.day, date, availability: r.availability,
      ...(r.slotsRemaining !== undefined ? { slotsRemaining: r.slotsRemaining } : {}),
    };
  }));
}

async function applyOp(plan: EditablePlan, edit: PlanEdit, deps: EditDeps): Promise<Applied> {
  switch (edit.kind) {
    case 'remove_day': return removeDay(plan, edit.day);
    case 'move_day': return moveDay(plan, edit.day, edit.to);
    case 'add_day': return addDay(plan, edit.interest, deps);
    case 'set_lodging': return setLodging(plan, edit.tier);
    case 'flight_delay': return flightDelay(plan, edit.days, edit.keepReturn);
    case 'set_party': return setParty(plan, edit.adults ?? plan.params.adults, edit.children ?? plan.params.children);
    case 'shift_dates': return shiftDates(plan, edit, (deps.today ?? (() => kamchatkaDate(new Date())))());
    case 'replace_day': return replaceDay(plan, edit.day, edit.interest, deps);
  }
}

/**
 * Единственная точка правки плана: Кузьмич, MCP и (следующим шагом)
 * веб-планер. После операции — то, что зависит от даты и группы (M3):
 * места и цена туров, чьи дни сменили дату или группу; строки парков и МЧС
 * на днях, сменивших дату; прогноз погоды с них снимается.
 */
export async function applyPlanEdit(plan: EditablePlan, edit: PlanEdit, deps: EditDeps = DEFAULT_DEPS): Promise<EditResult> {
  const applied = await applyOp(plan, edit, deps);
  if (!applied.ok) return applied;
  const { moved, regroup, ...done } = applied;
  const next = done.plan;
  const rereadDays = regroup ? next.days.map((d) => d.day) : moved;
  const reread = rereadDays.length > 0 ? await rereadTours(next, rereadDays, deps.reread ?? rereadTourDay) : [];

  const startChanged = next.params.arrivalDate !== plan.params.arrivalDate;
  const safety = moved.length > 0 || startChanged
    ? await refreshDatedSafety(next.days, next.params.arrivalDate, moved, startChanged, deps.safety ?? DEFAULT_SAFETY_DEPS)
    : { warnings: [] };

  const warnings = [...safety.warnings, ...(done.warnings ?? [])];
  return {
    ...done,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(reread.length > 0 ? { reread } : {}),
  };
}
