/**
 * Расстояние до места на карточке каталога. Эталоны не выдумываем:
 * точный нулевой кейс ПК→ПК, симметрия и порядок величины.
 */

import { describe, it, expect } from 'vitest';
import { distanceKm } from '@/components/routes/place-horizons';

const PK = { lat: 53.0195, lng: 158.6505 };
const KLYUCHEVSKAYA = { lat: 56.056, lng: 160.642 };

describe('расстояние до места', () => {
  it('ПК → ПК: дистанция 0', () => {
    expect(distanceKm(PK, PK)).toBe(0);
  });

  it('дистанция симметрична и целая', () => {
    const d = distanceKm(PK, KLYUCHEVSKAYA);
    expect(d).toBe(distanceKm(KLYUCHEVSKAYA, PK));
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(400);
  });
});
