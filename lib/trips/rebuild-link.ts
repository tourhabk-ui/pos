/**
 * Адрес «Собрать заново» со страницы сохранённой поездки (аудит планировщика
 * 07.11, находка H17).
 *
 * Кнопка вела на пустой планер: человек заново вводил даты, состав и интересы
 * поездки, которая у него уже записана. В адрес идёт только то, что планер
 * читает из ссылки (app/planner/_PlannerClient.tsx), и границы судит он: 3–21
 * день, старт не в прошлом, плитка существует, взрослых 1–8. Второго правила
 * здесь нет — иначе два места разошлись бы первой же правкой.
 *
 * Сторож связки «положил в адрес — планер прочитал»:
 * tests/unit/trip-rebuild-link.test.tsx и tests/unit/planner-link-params.test.ts.
 */
import { tripCalendarDays } from '@/lib/planner/flow-balance';
import { calendarDay } from './trip-dates';
import type { TripParty } from './trip-schema';

export interface RebuildSource {
  arrival_date: string | null;
  departure_date: string | null;
  places: string[];
  activities: string[];
  party: Pick<TripParty, 'adults' | 'children'> | null;
}

export function plannerRebuildHref(trip: RebuildSource): string {
  const q = new URLSearchParams();
  // Даты — парой: планер берёт старт только вместе с длительностью.
  const from = calendarDay(trip.arrival_date);
  const to = calendarDay(trip.departure_date);
  const days = from && to ? tripCalendarDays(from, to) : 0;
  if (from && days > 0) {
    q.set('from', from);
    q.set('days', String(days));
  }
  // Интересы — id плиток, как их сохранил планер; иное в адрес не идёт.
  const tiles = [...new Set([...trip.places, ...trip.activities])].filter((t) => /^[a-z_]{1,30}$/.test(t));
  if (tiles.length > 0) q.set('hint', tiles.join(','));
  // Состав — только записанный: у поездки до 09.10 его нет, планер спросит сам.
  if (trip.party) {
    q.set('adults', String(trip.party.adults));
    if (trip.party.children.length > 0) q.set('children', trip.party.children.join(','));
  }
  const qs = q.toString();
  return qs ? `/planner?${qs}` : '/planner';
}
