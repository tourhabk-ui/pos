/**
 * Сколько дней и ночей в поездке — одна формула для шага «Когда» и для плана.
 *
 * До 24.10 шаг считал разницу дат (ночи) и подписывал её днями: 1–8 июля
 * было «7 дней», а план из движка (lib/planner/flow-balance, tripCalendarDays)
 * показывал 8 дней. Человек читал два разных числа об одной поездке.
 *
 * Дни — календарные, включая день прилёта и день отъезда. Ночи — на одну
 * меньше: в последний день ночёвки нет.
 */
import { tripCalendarDays } from '@/lib/planner/flow-balance';

function plural(n: number, one: string, few: string, many: string): string {
  const m100 = Math.abs(n) % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  switch (Math.abs(n) % 10) {
    case 1: return one;
    case 2:
    case 3:
    case 4: return few;
    default: return many;
  }
}

/** Календарные дни и ночи. Пустые, битые и перевёрнутые даты — null. */
export function tripStayCounts(arrival: string, departure: string): { days: number; nights: number } | null {
  const days = tripCalendarDays(arrival, departure);
  if (days < 1) return null;
  return { days, nights: Math.max(0, days - 1) };
}

/** «8 календарных дней · 7 ночей» по уже посчитанным числам. */
export function stayPhraseFromCounts(days: number, nights: number): string {
  const dayPart = `${days} ${plural(days, 'календарный день', 'календарных дня', 'календарных дней')}`;
  const nightPart = nights === 0
    ? 'без ночёвки'
    : `${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')}`;
  return `${dayPart} · ${nightPart}`;
}

/** «8 календарных дней · 7 ночей». Нет поездки — null, не ноль. */
export function tripStayPhrase(arrival: string, departure: string): string | null {
  const c = tripStayCounts(arrival, departure);
  if (!c) return null;
  return stayPhraseFromCounts(c.days, c.nights);
}
