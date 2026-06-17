import { describe, it, expect } from 'vitest';
import { haversineM, checkZone, checkBreach } from './geofence';
import type { GeofenceZone } from './geofence';

// Реальные координаты вулканов Камчатки из БД
const KLUCHEVSKAYA: [number, number] = [56.0566, 160.6428];
const BEZYMIANNY:   [number, number] = [55.9842, 160.5942];
const TOLBACHIK:    [number, number] = [55.8306, 160.3269];

const volcanoZone = (lat: number, lng: number, name = 'Тест'): GeofenceZone => ({
  id: 'z1',
  name,
  lat,
  lng,
  radiusM: 3000,
  hazard: 'volcano',
  level: 'danger',
  message: 'Вулканическая опасность',
});

describe('haversineM', () => {
  it('Ключевская ↔ Безымянный ~8-10 км', () => {
    const d = haversineM(...KLUCHEVSKAYA, ...BEZYMIANNY);
    expect(d).toBeGreaterThan(7_000);
    expect(d).toBeLessThan(12_000);
  });

  it('Ключевская ↔ Толбачик ~32 км', () => {
    const d = haversineM(...KLUCHEVSKAYA, ...TOLBACHIK);
    expect(d).toBeGreaterThan(28_000);
    expect(d).toBeLessThan(36_000);
  });

  it('одинаковые координаты → 0', () => {
    expect(haversineM(56, 160, 56, 160)).toBe(0);
  });

  it('симметричность', () => {
    const d1 = haversineM(...KLUCHEVSKAYA, ...BEZYMIANNY);
    const d2 = haversineM(...BEZYMIANNY, ...KLUCHEVSKAYA);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.01);
  });
});

describe('checkZone', () => {
  const zone = volcanoZone(...KLUCHEVSKAYA, 'Ключевская');

  it('в центре зоны → inside', () => {
    const breach = checkZone(...KLUCHEVSKAYA, 10, zone);
    expect(breach?.state).toBe('inside');
  });

  it('2 км от центра (внутри 3 км зоны) → inside', () => {
    // ~2 км по широте ≈ 0.018 градуса
    const breach = checkZone(KLUCHEVSKAYA[0] + 0.018, KLUCHEVSKAYA[1], 20, zone);
    expect(breach?.state).toBe('inside');
  });

  it('5 км от центра → null', () => {
    // ~5 км по широте ≈ 0.045 градуса
    const breach = checkZone(KLUCHEVSKAYA[0] + 0.045, KLUCHEVSKAYA[1], 20, zone);
    expect(breach).toBeNull();
  });

  it('3.5 км (margin 500м) с GPS-погрешностью 600м → uncertain', () => {
    // margin = 3500 - 3000 = 500м, погрешность 600м > 500м → uncertain
    const breach = checkZone(KLUCHEVSKAYA[0] + 0.0315, KLUCHEVSKAYA[1], 600, zone);
    expect(breach?.state).toBe('uncertain');
  });

  it('GPS-погрешность внутри зоны → always inside', () => {
    const breach = checkZone(KLUCHEVSKAYA[0] + 0.009, KLUCHEVSKAYA[1], 5000, zone);
    expect(breach?.state).toBe('inside');
  });
});

describe('checkBreach — приоритет', () => {
  it('выбирает critical над warning при одинаковом состоянии', () => {
    // обе зоны содержат точку (inside), critical побеждает по уровню
    const zones: GeofenceZone[] = [
      { ...volcanoZone(56.0, 160.0), id: 'low-zone',  level: 'warning',  radiusM: 50_000, name: 'Низкий' },
      { ...volcanoZone(56.0, 160.0), id: 'high-zone', level: 'critical', radiusM: 50_000, name: 'Высокий' },
    ];
    const breach = checkBreach(56.0, 160.0, 10, zones);
    expect(breach?.zone.id).toBe('high-zone');
  });

  it('пустой список зон → null', () => {
    expect(checkBreach(56.0, 160.0, 10, [])).toBeNull();
  });
});
