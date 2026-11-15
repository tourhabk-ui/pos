/**
 * Смета считает ночи по дням поездки, а не по записанным дням плана (разбор
 * планера 14.11, смета-1).
 *
 * Движок недобор не набивает: 1 прилёт, 2–3 занятия, 7 вылет. Экран /planner
 * достраивал свободные дни 4–6 сам, а Кузьмич, MCP и план из черновика — нет,
 * и смета у них давала три ночи вместо шести. Судится то, что видит человек:
 * строка проживания и цены туров на человека — одинаковые на всех
 * поверхностях. С 14.11 у строки проживания цены нет (слово владельца «5 -1»),
 * число ночей — есть.
 */
import { describe, it, expect } from 'vitest';
import { calculatePriceBreakdown, estimateGroup, withFreeDays, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';
import { fillCalendarGaps } from '@/lib/planner/calendar-days';

const PROFILE: EstimateProfile = { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' };
const d = (day: number, type: EstimateDay['type'], title: string, priceFrom = 0, priceTo = 0): EstimateDay => ({
  day, type, zone: 'avachinsky', title, priceFrom, priceTo,
});
const GAPPED = [
  d(1, 'arrival', 'Прилёт'),
  d(2, 'activity', 'Вулканы', 5000, 15000),
  d(3, 'activity', 'Источники', 1500, 5000),
  d(7, 'departure', 'Вылет'),
];

describe('смета по дням поездки', () => {
  it('план с пропусками: шесть ночей, как на экране после достройки', () => {
    const screen = fillCalendarGaps(GAPPED, null) as EstimateDay[];
    const lodging = (days: EstimateDay[]) => estimateGroup(days, PROFILE).lines.filter((l) => l.kind === 'lodging');
    expect(lodging(GAPPED).map((l) => l.basis)).toEqual(['6 ночей — цену называет хозяин жилья']);
    expect(lodging(GAPPED)).toEqual(lodging(screen));
    expect(calculatePriceBreakdown(GAPPED)).toEqual(calculatePriceBreakdown(screen));
  });

  it('свободные дни строк занятий не дают и цену не прибавляют', () => {
    const lines = estimateGroup(GAPPED, PROFILE).lines.filter((l) => l.kind === 'activity');
    expect(lines.map((l) => l.label)).toEqual(['«Вулканы», день 2', '«Источники», день 3']);
    // Дни без тура — без цены (14.11, «5 -1»): вилки дня в сумму не идут.
    expect(calculatePriceBreakdown(GAPPED)).toEqual({ tours: [0, 0], activityPricing: { tourPriced: 0, open: 2, excluded: 0, unpriced: 0 } });
  });

  it('свободный день — в зоне накануне; сбитый порядок не трогается', () => {
    const west = [d(1, 'arrival', 'Прилёт'), { ...d(2, 'activity', 'Опала'), zone: 'western' as const }, d(4, 'departure', 'Вылет')];
    expect(withFreeDays(west).map((x) => `${x.day}:${x.zone}`)).toEqual(['1:avachinsky', '2:western', '3:western', '4:avachinsky']);
    const dup = [d(1, 'arrival', 'Прилёт'), d(2, 'activity', 'А'), d(2, 'activity', 'Б'), d(4, 'departure', 'Вылет')];
    expect(withFreeDays(dup)).toEqual(dup);
  });
});
