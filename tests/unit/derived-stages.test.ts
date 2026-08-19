/**
 * Вычисленный этап не поверяет линию, из которой получен.
 *
 * ── Что охраняется ─────────────────────────────────────────────────────────
 *
 * У половины линий нет ни одной путевой точки, и черта отказывает им честно:
 * сверить линию не с чем. Соблазн очевиден — найти места вдоль линии и
 * посчитать их точками пути. Тогда 154 маршрута разом стали бы пригодными.
 *
 * И это была бы круговая поверка. Линию проверяют точками; если точки
 * получены ИЗ линии, проверка доказывает сама себя. Маршрут прошёл бы черту,
 * не доказав ничего, и платформа пообещала бы вести по линии, которую никто
 * не сверял. По такому обещанию человек идёт в поле.
 *
 * Поэтому сторож смотрит не на слова, а на ПУТЬ передачи: то, что вычислено,
 * не должно доходить ни до черты, ни до базы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveStages, ON_LINE_KM, NEAR_LINE_KM } from '@/lib/routes/derived-stages';
import { routeNavigability } from '@/lib/routes/navigability';

const API = readFileSync(join(process.cwd(), 'app/api/routes/[id]/route.ts'), 'utf-8');
const MODULE = readFileSync(join(process.cwd(), 'lib/routes/derived-stages.ts'), 'utf-8');

/** Прямая линия на восток от Петропавловска — считать по ней просто. */
const TRACK = Array.from({ length: 21 }, (_, i) => ({ lat: 53.0, lng: 158.0 + i * 0.01 }));

describe('вычисление ориентиров', () => {
  it('место на линии попадает в onLine, далёкое — никуда', () => {
    const r = deriveStages({
      track: TRACK,
      places: [
        { id: 'on', name: 'На линии', lat: 53.0005, lng: 158.05, locationType: 'volcano' },
        { id: 'near', name: 'Около', lat: 53.005, lng: 158.05, locationType: 'lake' },
        { id: 'far', name: 'Далеко', lat: 53.2, lng: 158.05, locationType: 'lake' },
      ],
    });
    expect(r.onLine.map(s => s.placeId)).toEqual(['on']);
    expect(r.nearLine.map(s => s.placeId)).toEqual(['near']);
  });

  it('порядок идёт вдоль линии, а не по расстоянию от начала', () => {
    const r = deriveStages({
      track: TRACK,
      places: [
        { id: 'b', name: 'Второе', lat: 53.0, lng: 158.15 },
        { id: 'a', name: 'Первое', lat: 53.0, lng: 158.05 },
      ],
    });
    expect(r.onLine.map(s => s.placeId)).toEqual(['a', 'b']);
    expect(r.onLine.map(s => s.position)).toEqual([0, 1]);
  });

  it('место с установленной связью не предлагается второй раз', () => {
    const places = [{ id: 'on', name: 'На линии', lat: 53.0005, lng: 158.05 }];
    expect(deriveStages({ track: TRACK, places }).onLine).toHaveLength(1);
    expect(deriveStages({ track: TRACK, places, establishedPlaceIds: ['on'] }).onLine).toHaveLength(0);
  });

  it('линии короче двух точек нечего предлагать', () => {
    expect(deriveStages({ track: [{ lat: 53, lng: 158 }], places: [
      { id: 'x', name: 'Х', lat: 53, lng: 158 },
    ] }).onLine).toEqual([]);
  });

  it('каждый ориентир называет своё происхождение и объясняет себя', () => {
    const r = deriveStages({
      track: TRACK,
      places: [{ id: 'on', name: 'На линии', lat: 53.0005, lng: 158.05 }],
    });
    expect(r.onLine[0].origin).toBe('derived');
    expect(r.onLine[0].why).toMatch(/Вычислено/);
  });

  it('избыточный сбор помечается, а не обрезается молча', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`, name: `Место ${i}`, lat: 53.0, lng: 158.0 + i * 0.005,
    }));
    const r = deriveStages({ track: TRACK, places: many });
    expect(r.sweeping).toBe(true);
    expect(r.onLine.length).toBe(20);
  });
});

describe('пороги — одни на платформу', () => {
  it('берутся из waypoint-proposals, а не заводятся заново', () => {
    expect(MODULE).toMatch(/from '@\/lib\/routes\/waypoint-proposals'/);
    expect(ON_LINE_KM).toBeLessThan(NEAR_LINE_KM);
  });
});

describe('круговая поверка невозможна', () => {
  it('черта не принимает вычисленных точек: у входа нет такого поля', () => {
    // Если бы `routeNavigability` умел брать вычисленные этапы, поверка стала
    // бы круговой одной строчкой в вызывающем коде. Она не умеет.
    const nav = readFileSync(join(process.cwd(), 'lib/routes/navigability.ts'), 'utf-8');
    expect(nav).not.toMatch(/derive|derivedStages/i);
  });

  it('карточка передаёт черте только установленные связи', () => {
    // Вход черты собирается из wpLinkKinds/wpRowsWithCoords — это строки
    // route_waypoints. Ни одно поле вычисления туда не заходит.
    const navCall = API.slice(API.indexOf('return routeNavigability('), API.indexOf('return routeNavigability(') + 1200);
    expect(navCall).not.toMatch(/derivedStages|deriveStages/);
  });

  it('вычисленное никуда не записывается', () => {
    expect(MODULE).not.toMatch(/INSERT|UPDATE|pool\.query|from '@\/lib\/db-pool'/);
    // В карточке результат уходит в ответ, а не в базу.
    expect(API).not.toMatch(/INSERT INTO route_waypoints/);
  });

  it('линия без точек по-прежнему отказывает', () => {
    const track: [number, number][] = TRACK.map(p => [p.lat, p.lng]);
    const verdict = routeNavigability({
      grade: 'sketch', track, waypoints: [], evidence: 'none',
    });
    expect(verdict.canLead).toBe(false);
  });
});

describe('ориентиры считаются только там, где путь не описан', () => {
  it('условие в карточке привязано к порогу черты, а не к своему числу', () => {
    expect(API).toMatch(/isPathPoint\)\.length < MIN_ROUTE_WAYPOINTS/);
  });
});
