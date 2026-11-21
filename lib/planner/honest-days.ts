/**
 * День без тура — не «идея», а честный пустой слот (кейс владельца 21.11,
 * /planner 24.11–04.12, 11 дней, двое: «полный провал»).
 *
 * Было: дни 8, 9 и 11 — «Идея · тура нет»: рыбалка в декабре (сам день
 * писал «сезон июль–сентябрь»), снегоходы, вертолёт; ради них — переезд
 * 7 ч в Западную зону и вертолёт на 600 км в Северную. Теперь занятие без
 * тура оператора и без маршрута из базы в план не ставится: на его месте —
 * «подходящего тура на эти даты нет» с предложением отдыха или удлинения
 * реального тура. Чего нет — того нет (§4.0), слот не выдумывается.
 */
import type { DayPlan } from '@/lib/planner/engine';

export const NO_TOUR_DAY_TITLE = 'Подходящего тура на эти даты нет';
export const NO_TOUR_DAY_TEXT =
  'Подходящего тура на эти даты в базе нет — слот не заполняли. Можно отдохнуть (термы, прогулка у жилья) или попросить оператора удлинить реальный тур из плана.';

/** Занятие без тура и без маршрута из базы — то, что раньше было «Идея · тура нет». */
export function isIdeaDay(d: Pick<DayPlan, 'type' | 'realTour' | 'activityMode'>): boolean {
  return d.type === 'activity' && !d.realTour && d.activityMode !== 'self';
}

export function noTourDay(day: number, zone: DayPlan['zone'], coords: DayPlan['coords']): DayPlan {
  return {
    day, type: 'rest', zone,
    title: NO_TOUR_DAY_TITLE,
    description: NO_TOUR_DAY_TEXT,
    activityType: 'rest',
    priceFrom: 0, priceTo: 0,
    coords,
    defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
  };
}

/** Дни-идеи — честным пустым слотом в той же зоне; остальное как было. */
export function replaceIdeaDays(days: readonly DayPlan[]): { days: DayPlan[]; replaced: number[] } {
  const replaced: number[] = [];
  const out = days.map((d) => {
    if (!isIdeaDay(d)) return d;
    replaced.push(d.day);
    return noTourDay(d.day, d.zone, d.coords);
  });
  return { days: out, replaced };
}
