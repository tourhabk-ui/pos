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
  distKm, buildOverpassQuery, parseOverpassWays, chooseWay, distToWayKm, wayToGeoJSON,
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

/**
 * Выбор тропы: решают путевые точки маршрута, а не длина тропы.
 *
 * Прежнее правило звучало так: любая тропа, чей конец в четырёх километрах от
 * якоря, годится; среди годных побеждает САМАЯ ДЛИННАЯ. Ни проверки второго
 * кандидата, ни сверки с точками маршрута.
 *
 * Это то самое правило, от которого репозиторий уже отказался: в
 * `lib/import/kml-inbox.ts` привязка по близости удалена — из 290 попыток
 * годными оказались 31, и там же записано, что чем длиннее трек, тем меньше
 * близость его начала о нём говорит. Здесь длина была призом.
 *
 * Цена ошибки выше обычной: линия получает метку `osm`, а `osm` входит в
 * список снятых источников — значит рисуется сплошной зелёной, «здесь идут».
 * Неверная привязка выглядит проверенным маршрутом.
 */
describe('chooseWay', () => {
  /** Две путевые точки вдоль тропы-кандидата. */
  const WPS = [
    { lat: R_LAT + 0.001, lng: R_LNG },
    { lat: R_LAT + 0.003, lng: R_LNG },
  ];

  it('принимает тропу, на которую ложатся точки маршрута', () => {
    const w = way(1, [[R_LAT, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.004, R_LNG]]);
    const c = chooseWay([w], R_LAT, R_LNG, WPS);
    expect(c.reason).toBe('ok');
    expect(c.way?.id).toBe(1);
    expect(c.worstWaypointKm).toBeLessThanOrEqual(2);
  });

  it('длина больше не приз: побеждает та, что лучше ложится на точки', () => {
    // Точки маршрута лежат в шести километрах к северу от якоря.
    const northWps = [
      { lat: R_LAT + 0.05, lng: R_LNG },
      { lat: R_LAT + 0.06, lng: R_LNG },
    ];
    // Короткая тропа идёт через них.
    const short = way(1, [[R_LAT, R_LNG], [R_LAT + 0.05, R_LNG], [R_LAT + 0.06, R_LNG]]);
    // Длинная начинается у того же якоря, но уходит на восток: узлов вчетверо
    // больше, а точки маршрута на ней не лежат. По прежнему правилу победила
    // бы именно она — «самая длинная среди близких».
    const longAside = way(2, Array.from({ length: 40 }, (_, i) => [R_LAT, R_LNG + 0.01 * i] as [number, number]));
    const c = chooseWay([short, longAside], R_LAT, R_LNG, northWps);
    expect(c.reason).toBe('ok');
    expect(c.way?.id).toBe(1);
  });

  it('отказ, если ни один конец не в пределах 4 км', () => {
    const far = way(9, [[R_LAT + 1, R_LNG + 1], [R_LAT + 1.001, R_LNG + 1], [R_LAT + 1.002, R_LNG + 1]]);
    expect(distKm(R_LAT, R_LNG, R_LAT + 1, R_LNG + 1)).toBeGreaterThan(MAX_START_DIST_KM);
    const c = chooseWay([far], R_LAT, R_LNG, WPS);
    expect(c.way).toBeNull();
    expect(c.reason).toBe('no_candidates');
  });

  it('отказ, если у маршрута нет двух точек — проверить привязку нечем', () => {
    // Линия, которую нечем проверить, получила бы вид снятого трека. Ровно то,
    // что запрещает черта (lib/routes/navigability).
    const w = way(1, [[R_LAT, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.004, R_LNG]]);
    expect(chooseWay([w], R_LAT, R_LNG, []).reason).toBe('no_waypoints');
    expect(chooseWay([w], R_LAT, R_LNG, [WPS[0]]).reason).toBe('no_waypoints');
  });

  it('отказ, если точки маршрута с тропой не сходятся', () => {
    const w = way(1, [[R_LAT, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.004, R_LNG]]);
    const farWps = [
      { lat: R_LAT + 0.2, lng: R_LNG + 0.2 },
      { lat: R_LAT + 0.25, lng: R_LNG + 0.25 },
    ];
    const c = chooseWay([w], R_LAT, R_LNG, farWps);
    expect(c.way).toBeNull();
    expect(c.reason).toBe('waypoints_conflict');
    expect(c.worstWaypointKm).toBeGreaterThan(2);
  });

  it('отказ при неоднозначности: две тропы ложатся одинаково хорошо', () => {
    // Два трека, одинаково подходящие под точки, — это не выбор, а гадание.
    const a = way(1, [[R_LAT, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.004, R_LNG]]);
    const b = way(2, [[R_LAT, R_LNG], [R_LAT + 0.002, R_LNG], [R_LAT + 0.0045, R_LNG]]);
    const c = chooseWay([a, b], R_LAT, R_LNG, WPS);
    expect(c.way).toBeNull();
    expect(c.reason).toBe('ambiguous');
    expect(c.runnerUpId).toBeTypeOf('number');
  });

  it('близость по-прежнему считается по ближайшему из двух концов', () => {
    const w = way(3, [[R_LAT + 1, R_LNG], [R_LAT + 0.5, R_LNG], [R_LAT + 0.001, R_LNG]]);
    const wps = [
      { lat: R_LAT + 0.5, lng: R_LNG },
      { lat: R_LAT + 0.6, lng: R_LNG },
    ];
    expect(chooseWay([w], R_LAT, R_LNG, wps).way?.id).toBe(3);
  });
});

describe('distToWayKm — расстояние до ЛОМАНОЙ, а не до вершины', () => {
  it('точка напротив середины звена ближе, чем до его концов', () => {
    // Вершины могут стоять через километры: «ближайшая вершина» увела бы
    // вбок от места, где точка реально лежит на тропе.
    const w = way(1, [[R_LAT, R_LNG], [R_LAT + 0.02, R_LNG]]);
    const mid = { lat: R_LAT + 0.01, lng: R_LNG };
    const toVertex = Math.min(
      distKm(mid.lat, mid.lng, R_LAT, R_LNG),
      distKm(mid.lat, mid.lng, R_LAT + 0.02, R_LNG),
    );
    expect(distToWayKm(mid, w)).toBeLessThan(toVertex);
    expect(distToWayKm(mid, w)).toBeLessThan(0.05);
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
