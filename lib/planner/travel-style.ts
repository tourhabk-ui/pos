/**
 * Стиль поездки и дни отдыха: правила, которыми движок их исполняет.
 *
 * Владелец 26.09: в форме планировщика человек выбирает «Сам», «С
 * оператором» или «Вперемешку» и сколько дней отдыха ему нужно. Движок
 * (`recommendTrip`) исполняет выбор и возвращает заметки: где просьба
 * выполнена, а где нет и почему.
 *
 * ── Главное правило «Сам» — безопасность, а не удобство ─────────────────
 *
 * Самостоятельный день — это обещание «сюда можно без гида». Давать его
 * можно только там, где НАШИ ЖЕ данные этого не запрещают. Свойств
 * безопасности здесь не выдумывается ни одного — каждое правило читает то,
 * что платформа уже записала:
 *
 *   активность (`ACTIVITY_CONSTRAINTS`, `lib/safety/tour-risk`):
 *     — добраться можно только вертолётом или катером (`requiredTransport`);
 *     — нужно разрешение заповедника (`requiresPermit`);
 *     — в правилах безопасности активности гид назван обязательным;
 *     — вид активности платформа относит к высокому риску (`isHighRiskTour`);
 *
 *   маршрут (`kamchatka_routes`):
 *     — `mchs_registration_required` / `registration_required`;
 *     — сложность высокого риска (`isHighRiskTour` по `difficulty`);
 *
 *   место (`location_safety_profile`):
 *     — `sat_communicator_required`, `registration_required`.
 *
 * Нет данных о месте или не удалось их прочитать — это «не знаем», и оно
 * БЛОКИРУЕТ самостоятельный день (§4.0: для своей страницы непроверенность
 * блокирует). Обещать «можно самому» там, где мы не посмотрели, — ровно та
 * подмена третьего исхода первым, от которой правило и написано.
 *
 * Модуль чистый: ни базы, ни сети — поэтому его судит юнит-тест напрямую.
 */

import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES, rawTypesFor } from '@/lib/planner/constants';
import { highRiskReason } from '@/lib/safety/tour-risk';

export type TravelStyle = 'self' | 'operator' | 'mixed';

export const TRAVEL_STYLES: readonly TravelStyle[] = ['self', 'operator', 'mixed'] as const;

/** Подпись и пояснение — одни для формы и для экрана результата. */
export const TRAVEL_STYLE_LABEL: Record<TravelStyle, { label: string; hint: string }> = {
  self: { label: 'Сам', hint: 'Идёте без гида там, где это безопасно. Туры операторов не ставим' },
  operator: { label: 'С оператором', hint: 'Каждый активный день — тур оператора со свободными местами на ваши даты' },
  mixed: { label: 'Вперемешку', hint: 'Где есть тур — с оператором, где нет — сами, и дни отдыха между ними' },
};

/** Потолок дней отдыха, который принимает API. Движок режет ещё и сроком поездки. */
export const MAX_REST_DAYS = 14;

/** Строка данных безопасности по одному кандидату (маршрут или место). */
export interface SelfSafetyRow {
  /** Кандидат найден среди маршрутов `kamchatka_routes`. */
  isRoute: boolean;
  routeDifficulty: string | null;
  mchsRegistrationRequired: boolean | null;
  routeRegistrationRequired: boolean | null;
  /** У места есть строка в `location_safety_profile`. */
  hasProfile: boolean;
  satCommunicatorRequired: boolean | null;
  placeRegistrationRequired: boolean | null;
}

/** «Гид обязателен» словами правил безопасности активности. */
const GUIDE_MANDATORY = /(только\s+с|обязател\S*)[^.;]*гид|гид\S*[^.;]*обязател/i;

/**
 * Почему активность нельзя ставить самостоятельным днём; `null` — можно.
 * Причина — для человека, по-русски.
 */
export function activitySelfBlocker(interest: string): string | null {
  const c = ACTIVITY_CONSTRAINTS[interest];
  const name = ACTIVITY_NAMES[interest] ?? interest;
  if (!c) return `${name}: нет наших данных об этой активности`;
  if (c.requiredTransport === 'helicopter') return `${name}: добраться можно только вертолётом — рейс организует оператор`;
  if (c.requiredTransport === 'boat') return `${name}: нужен выход на катере — судно и капитана даёт оператор`;
  if (c.requiresPermit) return `${name}: нужно разрешение (${c.requiresPermit})`;
  const guideNote = (c.safetyNotes ?? []).find((n) => GUIDE_MANDATORY.test(n));
  if (guideNote) return `${name}: ${guideNote.charAt(0).toLowerCase()}${guideNote.slice(1)}`;
  for (const raw of rawTypesFor(interest)) {
    const risk = highRiskReason(null, raw);
    if (risk) return `${name}: высокий риск (${risk})`;
  }
  return null;
}

/** Сказано вслух, когда данных о месте нет или их не удалось прочитать. */
export const SELF_SAFETY_UNKNOWN = 'нет данных о безопасности — без гида не ставим';

/**
 * Почему маршрут или место нельзя ставить самостоятельным днём; `null` —
 * можно. `row === undefined` — данных нет вовсе, это тоже отказ.
 */
export function routeSelfBlocker(row: SelfSafetyRow | undefined): string | null {
  if (!row) return SELF_SAFETY_UNKNOWN;
  if (row.isRoute) {
    if (row.mchsRegistrationRequired === true) return 'группу обязательно регистрировать в МЧС — идите с оператором';
    if (row.routeRegistrationRequired === true) return 'требуется регистрация группы — идите с оператором';
    const risk = highRiskReason(row.routeDifficulty, null);
    if (risk) return `${risk} — без гида не ставим`;
    return null;
  }
  if (!row.hasProfile) return SELF_SAFETY_UNKNOWN;
  if (row.satCommunicatorRequired === true) return 'нужна спутниковая связь — без гида не ставим';
  if (row.placeRegistrationRequired === true) return 'требуется регистрация — идите с оператором';
  return null;
}

/**
 * Сколько дней отдыха поместится. Прилёт и вылет уже вычтены из
 * `activeBudget`; хотя бы один активный день остаётся всегда — поездка из
 * одних дней отдыха планом не является, и просить её формой нельзя.
 */
export function fitRestDays(requested: number | undefined, activeBudget: number): number {
  const want = Math.max(0, Math.floor(requested ?? 0));
  if (want === 0 || activeBudget <= 1) return 0;
  return Math.min(want, activeBudget - 1);
}

/** Раз в сколько активных дней ставить отдых, чтобы разложить его ровно. */
export function restSpacing(activityBudget: number, restDays: number): number {
  if (restDays <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(activityBudget / (restDays + 1)));
}

/** Как исполнена просьба: полностью, частично или никак. */
export type PreferenceStatus = 'honoured' | 'partial' | 'not_honoured';

export interface PreferenceNote {
  topic: 'travel_style' | 'rest_days';
  status: PreferenceStatus;
  message: string;
}

/** Что попросили и что вышло — отдаётся наружу рядом с планом. */
export interface TripPreferences {
  travelStyle: TravelStyle;
  restDaysRequested: number;
  restDaysPlanned: number;
  notes: PreferenceNote[];
}
