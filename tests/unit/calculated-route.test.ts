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
  MAX_CAR_SNAP_M, withinSnapTolerance, calculatedCarToLeafletCoordinates,
  type CalculatedCarRoute,
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

/**
 * calculatedCarToLeafletCoordinates — единственная граница, где GeoJSON
 * [lng, lat] становится Leaflet [lat, lng] (владелец 28.08, план рендеринга
 * calculated_car, §7). Порядок ФИКСИРОВАН — функция не имеет права угадывать
 * его по диапазону значений (§4.0 CLAUDE.md — третье состояние, не догадка).
 */
describe('calculatedCarToLeafletCoordinates — фиксированная граница осей, без угадывания', () => {
  function withCoords(coordinates: unknown): Pick<CalculatedCarRoute, 'geometry'> {
    return { geometry: { type: 'LineString', coordinates: coordinates as [number, number][] } };
  }

  it('пример из плана: [lng,lat] → [lat,lng], без исключений', () => {
    const result = calculatedCarToLeafletCoordinates(withCoords([
      [158.45052, 53.186963],
      [158.649992, 53.035011],
    ]));
    expect(result).toEqual([
      [53.186963, 158.45052],
      [53.035011, 158.649992],
    ]);
  });

  it('меньше двух точек — null, линия из одной точки не путь', () => {
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963]]))).toBeNull();
    expect(calculatedCarToLeafletCoordinates(withCoords([]))).toBeNull();
  });

  it('geometry отсутствует или не LineString — null, не выдумываем форму', () => {
    expect(calculatedCarToLeafletCoordinates({ geometry: undefined as unknown as CalculatedCarRoute['geometry'] })).toBeNull();
    expect(calculatedCarToLeafletCoordinates(withCoords(null))).toBeNull();
  });

  it('нечисловая или неконечная координата — null, не координата догадкой', () => {
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963], ['x', 53.035011]]))).toBeNull();
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963], [Infinity, 53.035011]]))).toBeNull();
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963], [NaN, 53.035011]]))).toBeNull();
  });

  it('координата вне диапазона — null (грубый конверт, не приговор о правде, но защита от мусора)', () => {
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963], [200, 53.035011]]))).toBeNull();
    expect(calculatedCarToLeafletCoordinates(withCoords([[158.45052, 53.186963], [158.649992, 95]]))).toBeNull();
  });

  it('НЕ угадывает порядок осей по диапазону — оси всегда [lng,lat]→[lat,lng], даже если lng<90', () => {
    // Первое число (lng) внутри диапазона широт — угадыватель по диапазону
    // мог бы счесть это уже [lat,lng] и не переставлять. Конвертер обязан
    // всё равно применить ФИКСИРОВАННЫЙ порядок: вход — GeoJSON по контракту.
    const result = calculatedCarToLeafletCoordinates(withCoords([[53.1, 53.186963], [53.2, 53.035011]]));
    expect(result).toEqual([[53.186963, 53.1], [53.035011, 53.2]]);
  });
});
