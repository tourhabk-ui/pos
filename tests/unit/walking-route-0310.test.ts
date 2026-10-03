/**
 * Пеший путь (03.10). Владелец, со снимком Яндекса: «даже у яндекса это уже
 * есть», «мы безнадежно отстаем». Граф с тропами и режим `foot` в A* были
 * давно; не хватало двери (/api/routes/build отвечал отказом), рода линии и
 * выбора режима на экране.
 */
import { describe, it, expect } from 'vitest';
import { calculatedFootLine, calculatedCarLine, calculatedLine } from '@/lib/map/line-standard';
import { footRouteReach, MAX_FOOT_DEST_SNAP_M, MAX_CAR_SNAP_M } from '@/lib/on-route/calculated-route';
import { defaultMode, formatDuration, FOOT_DEFAULT_MAX_M } from '@/components/places/PlaceOwnRoute';
import type { CalculatedCarRoute } from '@/lib/on-route/calculated-route';

const snaps = (o: number, d: number) => ({
  originSnapped: { lat: 0, lon: 0, snapDistanceM: o },
  destinationSnapped: { lat: 0, lon: 0, snapDistanceM: d },
});

describe('линия пешего пути (§12)', () => {
  it('пунктир — не обещание «здесь шли» и не «проедешь»', () => {
    const foot = calculatedFootLine();
    expect(foot.style.dashArray).toBeTruthy();
    expect(calculatedCarLine().style.dashArray).toBeUndefined();
    expect(foot.style.color).toBe(calculatedCarLine().style.color);
  });

  it('подпись говорит, что путь не проверен и время без подъёмов', () => {
    expect(calculatedFootLine().caption).toMatch(/никто не проверял/);
    expect(calculatedFootLine().caption).toMatch(/без учёта подъёмов/);
  });

  it('род линии — по режиму расчёта; нет режима — машина (старые ответы)', () => {
    expect(calculatedLine('foot').kind).toBe('calculated_foot');
    expect(calculatedLine('car').kind).toBe('calculated_car');
    expect(calculatedLine(undefined).kind).toBe('calculated_car');
  });
});

describe('дошла ли тропа до цели', () => {
  it('пешеходу прощается меньше, чем машине', () => {
    expect(MAX_FOOT_DEST_SNAP_M).toBeLessThan(MAX_CAR_SNAP_M);
    expect(footRouteReach(snaps(50, MAX_FOOT_DEST_SNAP_M))).toBe('reaches');
    expect(footRouteReach(snaps(50, MAX_FOOT_DEST_SNAP_M + 1))).toBe('approach');
    expect(footRouteReach(snaps(MAX_CAR_SNAP_M + 1, 10))).toBe('unusable');
  });
});

describe('какой режим открыть первым', () => {
  const route = (distanceM: number) => ({ kind: 'route' as const, title: null, route: { distanceM } as CalculatedCarRoute });
  const no = { kind: 'refused' as const, message: 'нет' };
  it('пешком, если путь есть и недлинный; иначе машина', () => {
    expect(defaultMode(route(30000), route(4000))).toBe('foot');
    expect(defaultMode(route(30000), route(FOOT_DEFAULT_MAX_M + 1))).toBe('car');
    expect(defaultMode(no, route(20000))).toBe('foot');
    expect(defaultMode(route(30000), no)).toBe('car');
  });

  it('время — как у навигаторов', () => {
    expect(formatDuration(3780)).toBe('1 ч 3 мин');
    expect(formatDuration(900)).toBe('15 мин');
    expect(formatDuration(10)).toBe('1 мин');
  });
});
