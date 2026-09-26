/**
 * Сторож: подъезд к маршруту — по дорогам общего пользования (26.09).
 *
 * Владелец: «мы же решили, что трек по дороге общего пользования». Роутер по
 * дорожному графу был, его описание называло отрезок «от меня до старта
 * тропы», но экран поля его не звал — рисовалась прямая через хребты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  wantsRoadApproach, roadApproachKey, displayableRoadApproach, trailheadGap,
  ROAD_APPROACH_MIN_KM, TRAILHEAD_GAP_DRAW_M,
} from '@/lib/on-route/road-approach';
import type { CalculatedCarRoute } from '@/lib/on-route/calculated-route';

const route = (over: Partial<CalculatedCarRoute> = {}): CalculatedCarRoute => ({
  kind: 'calculated_car',
  geometry: { type: 'LineString', coordinates: [[158.65, 53.02], [158.70, 53.20], [158.78, 53.25]] },
  distanceM: 54_500, durationS: 4_200,
  originSnapped: { lat: 53.02, lon: 158.65, snapDistanceM: 20 },
  destinationSnapped: { lat: 53.25, lon: 158.78, snapDistanceM: 900 },
  provider: 'road_graph', builtAt: '2026-09-26T07:00:00Z', traffic: false,
  mayDisplay: true, mayNavigate: false, mayPersist: false,
  ...over,
});

describe('когда просить подъезд по дорогам', () => {
  const base = { offTrack: true, approachKm: 30.9, offline: false, hasStart: true };
  it('случай 26.09: 30.9 км от линии, сеть есть — просим', () => {
    expect(wantsRoadApproach(base)).toBe(true);
  });
  it('ближе порога — выход на тропу пешком, роутер не зовём', () => {
    expect(wantsRoadApproach({ ...base, approachKm: ROAD_APPROACH_MIN_KM - 0.1 })).toBe(false);
  });
  it('без сети, на маршруте, без старта или без измерения — нет', () => {
    expect(wantsRoadApproach({ ...base, offline: true })).toBe(false);
    expect(wantsRoadApproach({ ...base, offTrack: false })).toBe(false);
    expect(wantsRoadApproach({ ...base, hasStart: false })).toBe(false);
    expect(wantsRoadApproach({ ...base, approachKm: null })).toBe(false);
  });
});

describe('ключ запроса', () => {
  it('в пределах ~километра ключ не меняется — роутер не зовут на каждом шаге', () => {
    expect(roadApproachKey('s', 53.0212, 158.6511)).toBe(roadApproachKey('s', 53.0249, 158.6538));
    expect(roadApproachKey('s', 53.0212, 158.6511)).not.toBe(roadApproachKey('s', 53.0412, 158.6511));
  });
});

describe('что рисуется', () => {
  it('путь, который сервер запретил показывать, не рисуется', () => {
    expect(displayableRoadApproach(route({ mayDisplay: false }))).toBeNull();
    expect(displayableRoadApproach(null)).toBeNull();
    expect(displayableRoadApproach(route())).not.toBeNull();
  });

  it('дорога не дотягивает до старта — пунктир от конца дороги до старта', () => {
    const gap = trailheadGap(route(), [53.26, 158.80]);
    expect(gap).toEqual({ from: [53.25, 158.78], to: [53.26, 158.80], meters: 900 });
  });

  it('дорога у старта — пунктира нет', () => {
    expect(trailheadGap(route({ destinationSnapped: { lat: 53.25, lon: 158.78, snapDistanceM: TRAILHEAD_GAP_DRAW_M - 1 } }), [53.25, 158.78])).toBeNull();
  });
});

describe('экран поля подключён', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf8');

  it('подъезд просится у того же роутера до СТАРТА маршрута, на машине', () => {
    expect(SRC).toMatch(/destination: \{ kind: 'coordinate', lat: trackStartLat, lon: trackStartLng, title: 'Старт маршрута' \},\s*mode: 'car'/);
  });

  it('ложится тем же каналом рассчитанного автопути, а не третьим способом', () => {
    expect(SRC).toContain('const mapCalculated = calculatedPreview?.route ?? autoBuiltRoute ?? roadRoute;');
  });

  it('с путём по дорогам прямая через хребты не рисуется — только разрыв до старта', () => {
    expect(SRC).toMatch(/if \(roadRoute && trackStartLat !== null && trackStartLng !== null\) \{\s*return trailheadGap\(roadRoute, \[trackStartLat, trackStartLng\]\);/);
  });

  it('отказ роутера не глушится — в лог, а на карте остаётся прямая с подписью «по прямой»', () => {
    expect(SRC).toContain("console.error('[road-approach] подъезд по дорогам не построен:'");
    expect(SRC).toContain('до линии по прямой');
  });

  it('подпись говорит, что путь рассчитан, а не снят', () => {
    expect(SRC).toContain('Путь рассчитан по дорожной сети — это не снятый трек.');
  });
});
