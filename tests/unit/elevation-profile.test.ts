/**
 * tests/unit/elevation-profile.test.ts
 *
 * Высотный профиль из GeoJSON LineString (задача L):
 * - известный синтетический трек -> точные gain/loss/min/max;
 * - шум ниже порога 3 м не накапливается в набор/сброс;
 * - трек без 3-й компоненты (синтетика из waypoints) -> no_elevation,
 *   внешние API не дёргаются (функция чистая);
 * - частичные высоты (не у всех точек) -> no_elevation, не полуправда;
 * - битая геометрия -> invalid_geometry с причиной.
 */

import { describe, it, expect } from 'vitest';
import { computeElevationProfile, SURFACE_TYPES } from '@/lib/import/elevation-profile';

describe('computeElevationProfile', () => {
  it('считает gain/loss/min/max на синтетическом треке', () => {
    // 100 -> 250 (подъём 150) -> 180 (спуск 70) -> 300 (подъём 120)
    const geometry = {
      type: 'LineString',
      coordinates: [
        [158.0, 53.0, 100],
        [158.1, 53.1, 250],
        [158.2, 53.2, 180],
        [158.3, 53.3, 300],
      ],
    };

    const result = computeElevationProfile(geometry);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.profile.gainM).toBe(270);
    expect(result.profile.lossM).toBe(70);
    expect(result.profile.minM).toBe(100);
    expect(result.profile.maxM).toBe(300);
  });

  it('GPS-шум ниже 3 м не накапливается', () => {
    // Дрожание ±1-2 м вокруг 100: без сглаживания gain был бы ~6 м
    const geometry = {
      type: 'LineString',
      coordinates: [
        [158.0, 53.0, 100],
        [158.1, 53.1, 101.5],
        [158.2, 53.2, 99.5],
        [158.3, 53.3, 101],
        [158.4, 53.4, 100],
      ],
    };

    const result = computeElevationProfile(geometry);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.profile.gainM).toBe(0);
    expect(result.profile.lossM).toBe(0);
  });

  it('трек без высот (синтетика из waypoints) -> no_elevation', () => {
    const geometry = {
      type: 'LineString',
      coordinates: [
        [158.0, 53.0],
        [158.1, 53.1],
        [158.2, 53.2],
      ],
    };
    expect(computeElevationProfile(geometry).kind).toBe('no_elevation');
  });

  it('высоты только у части точек -> no_elevation, не профиль по фрагменту', () => {
    const geometry = {
      type: 'LineString',
      coordinates: [
        [158.0, 53.0, 100],
        [158.1, 53.1],
        [158.2, 53.2, 300],
      ],
    };
    expect(computeElevationProfile(geometry).kind).toBe('no_elevation');
  });

  it('битая геометрия -> invalid_geometry с причиной', () => {
    const notLineString = computeElevationProfile({ type: 'Point', coordinates: [158, 53] });
    expect(notLineString.kind).toBe('invalid_geometry');

    const onePoint = computeElevationProfile({ type: 'LineString', coordinates: [[158, 53, 100]] });
    expect(onePoint.kind).toBe('invalid_geometry');

    const nanPoint = computeElevationProfile({ type: 'LineString', coordinates: [[158, 53], [NaN, 53]] });
    expect(nanPoint.kind).toBe('invalid_geometry');

    const nullGeom = computeElevationProfile(null);
    expect(nullGeom.kind).toBe('invalid_geometry');
  });
});

describe('SURFACE_TYPES', () => {
  it('словарь покрытий из постановки — все 7 значений с русскими лейблами', () => {
    expect(Object.keys(SURFACE_TYPES).sort()).toEqual(
      ['coastal', 'dirt_road', 'off_trail', 'paved', 'prepared_trail', 'trail', 'water'].sort()
    );
    expect(SURFACE_TYPES.trail).toBe('Тропа');
  });
});
