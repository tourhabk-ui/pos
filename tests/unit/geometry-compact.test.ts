/**
 * Детектор «паутины»: синтетическая геометрия сборников (сегменты >25 км)
 * не должна рисоваться как трек и предлагаться для навигации.
 */

import { describe, it, expect } from 'vitest';
import { maxSegmentKm, boundingSpanKm, isScatteredCollection } from '@/lib/routes/geometry-compact';

describe('geometry-compact', () => {
  it('компактный маршрут (сегменты сотни метров) — не сборник', () => {
    const trail: Array<[number, number]> = [
      [53.20, 158.80], [53.21, 158.81], [53.22, 158.83], [53.23, 158.84],
    ];
    expect(isScatteredCollection(trail)).toBe(false);
    expect(maxSegmentKm(trail)).toBeLessThan(3);
  });

  it('паутина «по всему краю» (ПК → Эссо) — сборник', () => {
    const web: Array<[number, number]> = [
      [53.02, 158.65],  // Петропавловск
      [53.63, 158.85],  // Халактырка-север (~68 км)
      [55.93, 158.70],  // Эссо (~250 км)
    ];
    expect(isScatteredCollection(web)).toBe(true);
    expect(maxSegmentKm(web)).toBeGreaterThan(60);
  });

  it('кейс владельца «Вулкан Авачинский»: скачки < 25 км, но размах ~29 км — сборник', () => {
    // Пляж → визит-центр (город) → смотровая у вулкана: каждый прыжок короче
    // порога, но точки разбросаны на ~29 км — не пеший трек.
    const chain: Array<[number, number]> = [
      [53.02, 158.75],  // Халактырский пляж (океан)
      [53.05, 158.61],  // Визит-центр (город) — ~12 км
      [53.16, 158.66],  // промежуточная — ~13 км
      [53.28, 158.72],  // Смотровая у Авачинского — ~14 км
    ];
    expect(maxSegmentKm(chain)).toBeLessThan(25);       // ни одного длинного прыжка
    expect(boundingSpanKm(chain)).toBeGreaterThan(25);  // но размах большой
    expect(isScatteredCollection(chain)).toBe(true);
  });

  it('компактный маршрут — маленький размах, не сборник', () => {
    const trail: Array<[number, number]> = [
      [53.20, 158.80], [53.21, 158.81], [53.22, 158.83], [53.25, 158.86],
    ];
    expect(boundingSpanKm(trail)).toBeLessThan(25);
    expect(isScatteredCollection(trail)).toBe(false);
  });

  it('пустая/одноточечная геометрия — не сборник (нечего рисовать)', () => {
    expect(isScatteredCollection(null)).toBe(false);
    expect(isScatteredCollection([])).toBe(false);
    expect(isScatteredCollection([[53, 158]])).toBe(false);
  });

  it('порог настраиваемый', () => {
    const pair: Array<[number, number]> = [[53.0, 158.0], [53.1, 158.0]]; // ~11 км
    expect(isScatteredCollection(pair, 25)).toBe(false);
    expect(isScatteredCollection(pair, 10)).toBe(true);
  });
});
