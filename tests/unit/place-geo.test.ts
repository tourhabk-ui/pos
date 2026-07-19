/**
 * Гео-математика прибора карточки места: пеленг, дистанция, румбы, сезон.
 * Эталоны не выдумываем: проверяем симметрию (пеленг туда/обратно ~180°,
 * дистанция одинакова) и точный нулевой кейс ПК→ПК.
 */

import { describe, it, expect } from 'vitest';
import {
  bearingDeg, distanceKm, rumb16, seasonRoman,
  HORIZONS, horizonPath, closedHorizon,
} from '@/components/routes/place-horizons';
import { LOCATION_TYPE_LABELS } from '@/components/places/types';

const PK = { lat: 53.0195, lng: 158.6505 };
const KLYUCHEVSKAYA = { lat: 56.056, lng: 160.642 };

describe('гео-математика прибора', () => {
  it('ПК → ПК: дистанция 0', () => {
    expect(distanceKm(PK, PK)).toBe(0);
  });

  it('дистанция симметрична, пеленг туда и обратно отличаются на ~180°', () => {
    expect(distanceKm(PK, KLYUCHEVSKAYA)).toBe(distanceKm(KLYUCHEVSKAYA, PK));
    const fwd = bearingDeg(PK, KLYUCHEVSKAYA);
    const back = bearingDeg(KLYUCHEVSKAYA, PK);
    const expected = (fwd + 180) % 360;
    const raw = Math.abs(back - expected);
    expect(Math.min(raw, 360 - raw)).toBeLessThan(5);
  });

  it('Ключевская строго севернее и восточнее ПК — пеленг в секторе СВ (0–90°)', () => {
    const brg = bearingDeg(PK, KLYUCHEVSKAYA);
    expect(brg).toBeGreaterThan(0);
    expect(brg).toBeLessThan(90);
    expect(distanceKm(PK, KLYUCHEVSKAYA)).toBeGreaterThan(100);
  });

  it('rumb16: главные направления', () => {
    expect(rumb16(0)).toBe('С');
    expect(rumb16(90)).toBe('В');
    expect(rumb16(180)).toBe('Ю');
    expect(rumb16(270)).toBe('З');
    expect(rumb16(359)).toBe('С');
    expect(rumb16(22.5)).toBe('ССВ');
  });

  it('seasonRoman: диапазон, одиночный месяц, зимний перенос, пусто', () => {
    expect(seasonRoman([7, 8, 9])).toBe('VII–IX');
    expect(seasonRoman([7])).toBe('VII');
    expect(seasonRoman([12, 1, 2])).toBe('XII–II');
    expect(seasonRoman([])).toBe('');
    expect(seasonRoman(null)).toBe('');
    expect(seasonRoman([0, 13])).toBe('');
  });
});

describe('силуэты горизонта', () => {
  it('каждый известный location_type имеет путь', () => {
    for (const t of Object.keys(LOCATION_TYPE_LABELS)) {
      expect(HORIZONS[t], `нет силуэта для «${t}»`).toBeTruthy();
      expect(HORIZONS[t]).toMatch(/^M0,\d+/);
      expect(HORIZONS[t]).toMatch(/L200,\d+$/);
    }
  });

  it('horizonPath безопасен для неизвестного типа, closedHorizon замыкает', () => {
    expect(horizonPath('no_such')).toBe(HORIZONS.other);
    expect(horizonPath(null)).toBe(HORIZONS.other);
    expect(closedHorizon('M0,30 L200,30')).toBe('M0,30 L200,30 L200,46 L0,46 Z');
  });
});
