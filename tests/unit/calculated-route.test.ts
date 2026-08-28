/**
 * lib/on-route/calculated-route.ts — нормализованная форма посчитанного
 * автомобильного пути + порог привязки к дороге (владелец 28.08).
 *
 * Числа в тестах — НЕ придуманы: это реальные snap-расстояния из
 * регионального теста владельца на публичном демо-OSRM (35 м / 1.3 м —
 * координаты внутри Камчатки; 8.8 км — межрегиональная точка без
 * ограничения радиуса поиска дороги).
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_CAR_SNAP_M, withinSnapTolerance, type CalculatedCarRoute,
} from '@/lib/on-route/calculated-route';

function route(originSnapM: number, destSnapM: number): Pick<CalculatedCarRoute, 'originSnapped' | 'destinationSnapped'> {
  return {
    originSnapped: { lat: 53.186963, lon: 158.45052, snapDistanceM: originSnapM },
    destinationSnapped: { lat: 53.035011, lon: 158.649992, snapDistanceM: destSnapM },
  };
}

describe('MAX_CAR_SNAP_M — щедрый запас для грунтовых дорог, не карт-бланш', () => {
  it('порог — 1000 м, как решил владелец по итогам теста', () => {
    expect(MAX_CAR_SNAP_M).toBe(1000);
  });
});

describe('withinSnapTolerance — обе точки обязаны привязаться в пределах порога', () => {
  it('камчатская проба (35 м / 1.3 м) — в пределах', () => {
    expect(withinSnapTolerance(route(35.01300981, 1.336672814))).toBe(true);
  });

  it('межрегиональная проба (8.8 км) — ЗА пределами, ровно то, что нашёл владелец', () => {
    expect(withinSnapTolerance(route(1.336672814, 8804.39108))).toBe(false);
  });

  it('одна точка в порядке, другая — нет: провал ЛЮБОЙ из двух отклоняет путь целиком', () => {
    expect(withinSnapTolerance(route(50, 8804.39108))).toBe(false);
    expect(withinSnapTolerance(route(8804.39108, 50))).toBe(false);
  });

  it('ровно на границе — включительно (<=), не строго меньше', () => {
    expect(withinSnapTolerance(route(MAX_CAR_SNAP_M, 50))).toBe(true);
    expect(withinSnapTolerance(route(MAX_CAR_SNAP_M + 0.01, 50))).toBe(false);
  });
});
