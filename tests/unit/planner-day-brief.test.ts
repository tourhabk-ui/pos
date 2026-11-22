/** «В поездке» (фича 4): сегодня/завтра по датам плана, без догадок. */
import { describe, it, expect } from 'vitest';
import { tripBrief, briefWeatherLine, type BriefDayInput } from '@/lib/planner/day-brief';

const days: BriefDayInput[] = [
  { day: 1, title: 'Прилёт', zone: 'avacha' },
  { day: 2, title: 'Облёт вулканов', zone: 'south', weatherDependent: true,
    weather: { tempMin: -14, tempMax: -11, description: 'Снегопад', windKmh: 42, precipMm: 6, bad: true }, planB: ['Паратунка'] },
  { day: 3, title: 'Отъезд', dayWarnings: ['Парк закрыт для посещения'] },
];

describe('tripBrief', () => {
  it('нет дат — сводки нет', () => {
    expect(tripBrief(days, null, '2026-11-24').state).toBe('no_dates');
  });
  it('до поездки — сколько дней осталось', () => {
    expect(tripBrief(days, '2026-11-24', '2026-11-21')).toEqual({ state: 'before', daysLeft: 3 });
  });
  it('в первый день — сегодня день 1, завтра день 2 с риском погоды', () => {
    const b = tripBrief(days, '2026-11-24', '2026-11-24');
    if (b.state !== 'during') throw new Error(b.state);
    expect(b.items.map((i) => [i.label, i.day.day, i.date])).toEqual([['Сегодня', 1, '2026-11-24'], ['Завтра', 2, '2026-11-25']]);
    expect(b.items[0].weatherLine).toBeNull();
    expect(b.items[1].weatherRisk).toBe(true);
    expect(b.items[1].weatherLine).toBe('−14…−11 °C, снегопад, ветер 42 км/ч, осадки 6 мм');
  });
  it('в последний день — только сегодня', () => {
    const b = tripBrief(days, '2026-11-24', '2026-11-26');
    if (b.state !== 'during') throw new Error(b.state);
    expect(b.items.map((i) => i.label)).toEqual(['Сегодня']);
    expect(b.items[0].day.dayWarnings).toEqual(['Парк закрыт для посещения']);
  });
  it('после поездки — сводки нет', () => {
    expect(tripBrief(days, '2026-11-24', '2026-11-27').state).toBe('after');
  });
  it('погода без числа — строки нет', () => {
    expect(briefWeatherLine({ tempMin: NaN, tempMax: 1 })).toBeNull();
  });
});
