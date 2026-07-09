/**
 * tests/unit/osm-geometry.test.ts
 *
 * Чистая логика подбора OSM-трека (без сети/БД), вынесенная из
 * route+script в lib/import/osm-geometry.ts. Проверяем: bbox-запрос,
 * фильтр ≥3 узлов, 4 км-проксимити, выбор длиннейшего пути, ориентация
 * LineString от точки маршрута.
 */

import { describe, it, expect } from 'vitest';
import {
  distKm, buildOverpassQuery, parseOverpassWays, pickBestWay, wayToGeoJSON,
  MAX_START_DIST_KM, type OsmWay,
} from '@/lib/import/osm-geometry';

// ~53.25N, 158.7E (Камчатка). 1° широты ≈ 111 км.
const R_LAT = 53.25;
const R_LNG = 158.7;

function way(id: number, nodes: [number, number][]): OsmWay {
  return { id, tags: {}, geometry: nodes.map(([lat, lon]) => ({ lat, lon })) };
}

describe('distKm', () => {
  it('0 для совпадающих точек, ~111 км на 1° широты', () => {
    expect(distKm(R_LAT, R_LNG, R_LAT, R_LNG)).toBe(0);
    const d = distKm(53, 158, 54, 158);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('buildOverpassQuery', () => {
  it('bbox вокруг точки + фильтр highway path|track|footway', () => {
    const q = buildOverpassQuery(R_LAT, R_LNG);
    expect(q).toContain('highway"~"path|track|footway"');
    expect(q).toContain('out geom;');
    // юг < север, запад < восток
    expect(q).toContain(`(${R_LAT - 0.07},${R_LNG - 0.10},${R_LAT + 0.07},${R_LNG + 0.10})`);
  });
});

describe('parseOverpassWays', () => {
  it('оставляет только ways с ≥3 узлами; пустое/битое → []', () => {
    const data = { elements: [
      way(1, [[53.25, 158.70], [53.26, 158.71], [53.27, 158.72]]),
      way(2, [[53.25, 158.70], [53.26, 158.71]]),          // 2 узла — отбрасываем
      { id: 3, tags: {}, geometry: undefined } as unknown as OsmWay, // битый
    ] };
    const out = parseOverpassWays(data);
    expect(out.map(w => w.id)).toEqual([1]);
    expect(parseOverpassWays(null)).toEqual([]);
    expect(parseOverpassWays({})).toEqual([]);
  });
});

describe('pickBestWay', () => {
  it('среди близких (≤4 км) выбирает самый длинный по узлам', () => {
    const near5 = way(1, [[R_LAT, R_LNG], [R_LAT + 0.001, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.003, R_LNG], [R_LAT + 0.004, R_LNG]]);
    const near3 = way(2, [[R_LAT, R_LNG], [R_LAT + 0.001, R_LNG], [R_LAT + 0.002, R_LNG]]);
    expect(pickBestWay([near3, near5], R_LAT, R_LNG)!.id).toBe(1);
  });

  it('null, если ни один конец не в пределах 4 км', () => {
    const far = way(9, [[R_LAT + 1, R_LNG + 1], [R_LAT + 1.001, R_LNG + 1], [R_LAT + 1.002, R_LNG + 1]]);
    // конец далеко (>>4 км)
    expect(distKm(R_LAT, R_LNG, R_LAT + 1, R_LNG + 1)).toBeGreaterThan(MAX_START_DIST_KM);
    expect(pickBestWay([far], R_LAT, R_LNG)).toBeNull();
  });

  it('близость считается по ближайшему из двух концов', () => {
    // начало далеко, конец рядом → берём
    const w = way(3, [[R_LAT + 1, R_LNG], [R_LAT + 0.5, R_LNG], [R_LAT + 0.001, R_LNG]]);
    expect(pickBestWay([w], R_LAT, R_LNG)!.id).toBe(3);
  });
});

describe('wayToGeoJSON', () => {
  it('[lng,lat]-координаты, старт у точки маршрута (без разворота)', () => {
    const w = way(1, [[R_LAT, R_LNG], [R_LAT + 0.01, R_LNG], [R_LAT + 0.02, R_LNG]]);
    const gj = wayToGeoJSON(w, R_LAT, R_LNG);
    expect(gj.type).toBe('LineString');
    expect(gj.coordinates[0]).toEqual([R_LNG, R_LAT]); // [lon,lat]
    expect(gj.coordinates).toHaveLength(3);
  });

  it('разворачивает трек, если конец ближе к точке маршрута, чем начало', () => {
    // начало далеко, конец у точки → развернуть, чтобы старт был у точки
    const w = way(2, [[R_LAT + 0.02, R_LNG], [R_LAT + 0.01, R_LNG], [R_LAT, R_LNG]]);
    const gj = wayToGeoJSON(w, R_LAT, R_LNG);
    expect(gj.coordinates[0]).toEqual([R_LNG, R_LAT]);                 // старт у точки
    expect(gj.coordinates[2]).toEqual([R_LNG, R_LAT + 0.02]);          // дальний конец в хвосте
  });
});
