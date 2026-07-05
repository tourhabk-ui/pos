/**
 * tests/unit/geofence-freshness.test.ts
 *
 * Фидбэк владельца: при открытии карты вдали от Камчатки всплывал алерт
 * «Опасность: приближаетесь к зоне, до центра 0.7 км» — по УСТАРЕВШЕЙ
 * позиции из кеша (прошлая сессия у источника). Живой геофенс-алерт можно
 * показывать только по свежему фиксу; эти тесты фиксируют порог свежести.
 */

import { describe, it, expect } from 'vitest';
import {
  isPositionFreshForGeofence,
  GEOFENCE_MAX_POSITION_AGE_MS,
  checkBreach,
  type GeofenceZone,
} from '@/lib/safety/geofence';

const NOW = 1_700_000_000_000;

describe('isPositionFreshForGeofence', () => {
  it('свежая позиция (только что) — годна', () => {
    expect(isPositionFreshForGeofence(NOW, NOW)).toBe(true);
  });

  it('позиция 1 мин назад — годна (< 3 мин)', () => {
    expect(isPositionFreshForGeofence(NOW - 60_000, NOW)).toBe(true);
  });

  it('позиция старше порога (5 мин) — НЕ годна (устаревший кеш)', () => {
    expect(isPositionFreshForGeofence(NOW - 5 * 60_000, NOW)).toBe(false);
  });

  it('ровно на пороге (3 мин) — НЕ годна (строгое <)', () => {
    expect(isPositionFreshForGeofence(NOW - GEOFENCE_MAX_POSITION_AGE_MS, NOW)).toBe(false);
  });

  it('timestamp из будущего (рассинхрон часов) — НЕ годна', () => {
    expect(isPositionFreshForGeofence(NOW + 10_000, NOW)).toBe(false);
  });
});

describe('checkBreach остаётся корректным (алерт по реальной близости)', () => {
  // Радиус 500м: near-порог = 250м снаружи → точка в ~700м от центра (200м за
  // границей) попадает в 'near' — ровно кейс со скриншота (0.7 км, «приближаетесь»).
  const zone: GeofenceZone = {
    id: 'z1',
    name: 'Африканский термальный источник',
    lat: 53.0,
    lng: 158.0,
    radiusM: 500,
    hazard: 'thermal',
    level: 'danger',
    message: 'Температура воды до 95°C',
  };

  it('в ~0.7 км от центра при хорошей точности → near', () => {
    // ~0.63 км севернее центра: 0.0057° широты ≈ 634 м (за границей 500 м, в near-полосе)
    const breach = checkBreach(53.0057, 158.0, 20, [zone]);
    expect(breach?.state).toBe('near');
    expect(breach!.distanceM).toBeGreaterThan(500);
    expect(breach!.distanceM).toBeLessThan(750);
  });

  it('за много км → нет бреча', () => {
    expect(checkBreach(55.75, 37.62, 20, [zone])).toBeNull(); // Москва
  });
});
