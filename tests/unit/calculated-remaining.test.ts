/**
 * Остаток посчитанного пути — вдоль линии, не по прямой.
 *
 * Скрин владельца 03.10 («Дикие озерки»): синий путь петлёй по дорогам, а
 * главная цифра листа — «1.9 км до цели» (прямая) рядом с «~44 мин» всего
 * пути. «Человек может не рассчитать силы».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { calculatedRemaining } from '@/lib/on-route/calculated-remaining';
import { straightKm } from '@/lib/on-route/approach';

// Петля: старт и цель рядом (~1.1 км по прямой), путь уходит на юг и
// возвращается — так выглядел путь на скрине. GeoJSON: [lng, lat].
const START = { lat: 53.30, lng: 158.40 };
const GOAL = { lat: 53.30, lng: 158.4166 };
const loop = {
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [START.lng, START.lat],
      [158.40, 53.25],
      [158.4166, 53.25],
      [GOAL.lng, GOAL.lat],
    ] as [number, number][],
  },
  distanceM: 0, // заполняется ниже — мерка провайдера
};
const lineKm = straightKm(START, { lat: 53.25, lng: 158.40 })
  + straightKm({ lat: 53.25, lng: 158.40 }, { lat: 53.25, lng: 158.4166 })
  + straightKm({ lat: 53.25, lng: 158.4166 }, GOAL);

describe('calculatedRemaining', () => {
  it('у старта петли остаток — весь путь, а не прямая до цели', () => {
    const r = calculatedRemaining({ ...loop, distanceM: lineKm * 1000 }, START)!;
    const straight = straightKm(START, GOAL);
    expect(straight).toBeLessThan(1.2);
    expect(r.remainingKm).toBeGreaterThan(10);
    expect(r.remainingKm).toBeCloseTo(lineKm, 1);
    expect(r.fractionAhead).toBeCloseTo(1, 2);
    expect(r.offRouteKm).toBeLessThan(0.01);
  });

  it('на середине пути осталась половина — и время режется той же долей', () => {
    const mid = { lat: 53.25, lng: 158.4083 };
    const r = calculatedRemaining({ ...loop, distanceM: lineKm * 1000 }, mid)!;
    expect(r.fractionAhead).toBeCloseTo(0.5, 1);
    expect(r.alongKm).toBeCloseTo(lineKm / 2, 0);
  });

  it('длина — в мерке провайдера: прореженная ломаная короче настоящего пути', () => {
    const r = calculatedRemaining({ ...loop, distanceM: lineKm * 1000 * 1.4 }, START)!;
    expect(r.alongKm).toBeCloseTo(lineKm * 1.4, 1);
  });

  it('в стороне от линии подход по прямой входит в цифру и назван отдельно', () => {
    const aside = { lat: 53.30, lng: 158.37 }; // ~2 км западнее старта
    const r = calculatedRemaining({ ...loop, distanceM: lineKm * 1000 }, aside)!;
    expect(r.offRouteKm).toBeGreaterThan(1.5);
    expect(r.remainingKm).toBeCloseTo(r.alongKm + r.offRouteKm, 6);
  });

  it('нет положения или битая геометрия — цифры нет, прямая её не подменяет', () => {
    expect(calculatedRemaining({ ...loop, distanceM: 1000 }, null)).toBeNull();
    expect(calculatedRemaining({ geometry: { type: 'LineString', coordinates: [[158.4, 53.3]] }, distanceM: 1000 }, START)).toBeNull();
  });
});

describe('экран «На маршруте» берёт цифру из calculatedRemaining', () => {
  const TRAIL = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
  it('главная цифра автопути — не haversine до цели', () => {
    expect(TRAIL).not.toMatch(/const calcDistKm = [^\n]*haversine/);
    expect(TRAIL).toContain('const calcDistKm = calcLeft ? calcLeft.remainingKm : null;');
  });
  it('время — доля durationS по оставшейся доле пути', () => {
    expect(TRAIL).toMatch(/calculatedPreview\.route\.durationS \* \(calcLeft \? calcLeft\.fractionAhead : 1\)/);
  });
  it('подпись говорит «по пути», а не просто «до цели»', () => {
    expect(TRAIL).not.toContain('caption="до цели"');
    expect((TRAIL.match(/caption=\{calcCaption\}/g) ?? []).length).toBe(2);
  });
});
