/**
 * Судья принадлежности линии — сторож.
 *
 * Проверяется главное свойство: судья НЕ приговаривает по размаху и НЕ
 * приравнивает «не разобрать» к «чужая». Правильный трек, каким бы длинным
 * он ни был, обязан остаться `own`.
 */
import { describe, it, expect } from 'vitest';
import {
  lineOwnership, NEAR_OWN_KM, FAR_OWN_KM, APPROACH_TAIL_KM,
} from '@/lib/routes/line-ownership';

/** Ломаная из точки на восток: шаг в километрах по долготе. */
function eastLine(lat: number, lng0: number, stepKm: number, n: number): number[][] {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  return Array.from({ length: n }, (_, i) => [lng0 + (i * stepKm) / kx, lat]);
}

describe('lineOwnership', () => {
  const point = { lat: 52.72, lng: 158.22 };

  it('короткая линия у своей точки — своя', () => {
    const r = lineOwnership({ routePoint: point, coords: eastLine(52.72, 158.22, 0.2, 10) });
    expect(r.verdict).toBe('own');
  });

  it('длинная линия у своей точки остается своей — размах не приговор', () => {
    // 60 км на восток от самой точки: размах огромен, но начинается она здесь.
    const r = lineOwnership({ routePoint: point, coords: eastLine(52.72, 158.22, 1, 61) });
    expect(r.tailKm).toBeGreaterThan(APPROACH_TAIL_KM);
    // Дальний конец далеко — это подъезд/продолжение, но НЕ чужая линия.
    expect(r.verdict).toBe('own_with_approach');
    expect(r.reasons.join(' ')).toContain('число километров');
  });

  it('линия за полсотни километров — чужая', () => {
    const r = lineOwnership({ routePoint: point, coords: eastLine(53.3, 158.22, 0.2, 10) });
    expect(r.verdict).toBe('foreign');
    expect(r.nearestKm).toBeGreaterThan(FAR_OWN_KM);
  });

  it('между порогами — «не разобрать», а не «чужая»', () => {
    // ~6 км севернее: больше NEAR, меньше FAR.
    const r = lineOwnership({ routePoint: point, coords: eastLine(52.774, 158.22, 0.2, 10) });
    expect(r.nearestKm).toBeGreaterThan(NEAR_OWN_KM);
    expect(r.nearestKm).toBeLessThan(FAR_OWN_KM);
    expect(r.verdict).toBe('unclear');
  });

  it('нет линии или нет своей точки — «не разобрать», без приговора', () => {
    expect(lineOwnership({ routePoint: point, coords: [] }).verdict).toBe('unclear');
    expect(lineOwnership({ routePoint: point, coords: null }).verdict).toBe('unclear');
    expect(lineOwnership({ routePoint: null, coords: eastLine(52.72, 158.22, 0.2, 10) }).verdict)
      .toBe('unclear');
  });

  it('меряется расстояние до отрезка, а не до вершины', () => {
    // Две вершины в 20 км друг от друга; точка ровно посередине линии.
    const coords = eastLine(52.72, 158.12, 20, 2);
    const mid = { lat: 52.72, lng: coords[0][0] + (coords[1][0] - coords[0][0]) / 2 };
    const r = lineOwnership({ routePoint: mid, coords });
    expect(r.nearestKm).toBeLessThan(0.5);
    expect(r.verdict).not.toBe('foreign');
  });

  it('промах мимо собственного путевого места не даёт «своя» молча', () => {
    const r = lineOwnership({
      routePoint: point,
      coords: eastLine(52.72, 158.22, 0.2, 10),
      waypoints: [{ lat: 53.3, lng: 158.22 }],
    });
    expect(r.verdict).toBe('unclear');
    expect(r.worstWaypointKm).toBeGreaterThan(FAR_OWN_KM);
  });

  it('у вердикта всегда есть причина словами', () => {
    for (const c of [
      lineOwnership({ routePoint: point, coords: eastLine(52.72, 158.22, 0.2, 10) }),
      lineOwnership({ routePoint: point, coords: eastLine(53.3, 158.22, 0.2, 10) }),
      lineOwnership({ routePoint: null, coords: null }),
    ]) {
      expect(c.reasons.length).toBeGreaterThan(0);
    }
  });
});
