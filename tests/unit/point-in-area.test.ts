// @vitest-environment node
/**
 * В каких контурах лежит точка (15.10, перепись режима по схеме парков) —
 * библиотека и скрипт сверки мест с охраняемыми территориями OSM
 * (`scripts/oopt-contours.ts`, workflow place-oopt-contours.yml).
 *
 * Вызовом на граничных данных: дыра в контуре — не «внутри»; памятник внутри
 * парка — первым, от тесного к широкому; «ни в одном контуре» — пустой
 * список, а не отказ; ноль контуров в выгрузке — выход 1 (поломка выгрузки,
 * а не край без охраняемых территорий, §4.0).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  containingAreas, geometryArea, isProtectedArea, pointInGeometry, pointInPolygon,
  type AreaGeometry, type Ring,
} from '@/lib/geo/point-in-area';

const square = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

const PARK: AreaGeometry = { type: 'Polygon', coordinates: [square(158, 53, 160, 55), square(158.9, 53.9, 159.1, 54.1)] };
const MONUMENT: AreaGeometry = { type: 'Polygon', coordinates: [square(158.2, 53.2, 158.4, 53.4)] };
const ISLANDS: AreaGeometry = { type: 'MultiPolygon', coordinates: [[square(165.5, 54.5, 166.5, 55.5)], [square(167.4, 54.5, 168, 54.9)]] };

describe('точка в контуре', () => {
  it('внутри внешнего кольца — да; в дыре — нет; снаружи — нет', () => {
    expect(pointInPolygon(158.5, 53.5, PARK.coordinates as Ring[])).toBe(true);
    expect(pointInPolygon(159, 54, PARK.coordinates as Ring[])).toBe(false);
    expect(pointInPolygon(161, 54, PARK.coordinates as Ring[])).toBe(false);
  });

  it('мультиполигон: любой из островов', () => {
    expect(pointInGeometry(167.6, 54.7, ISLANDS)).toBe(true);
    expect(pointInGeometry(166, 55, ISLANDS)).toBe(true);
    expect(pointInGeometry(167, 55, ISLANDS)).toBe(false);
  });

  it('направление обхода кольца не важно', () => {
    const reversed: AreaGeometry = { type: 'Polygon', coordinates: [[...square(158, 53, 160, 55)].reverse()] };
    expect(pointInGeometry(158.5, 53.5, reversed)).toBe(true);
  });

  it('площадь — внешнее кольцо минус дыра', () => {
    expect(geometryArea(PARK)).toBeCloseTo(4 - 0.04, 6);
  });
});

describe('контуры точки — от тесного к широкому', () => {
  const areas = [
    { geometry: PARK, info: 'парк' },
    { geometry: MONUMENT, info: 'памятник' },
    { geometry: ISLANDS, info: 'острова' },
  ];

  it('памятник внутри парка стоит первым', () => {
    expect(containingAreas(158.3, 53.3, areas)).toEqual(['памятник', 'парк']);
  });

  it('ни в одном контуре — пустой список, а не отказ', () => {
    expect(containingAreas(157, 52, areas)).toEqual([]);
  });

  it('точки нет — пустой список', () => {
    expect(containingAreas(Number.NaN, 53, areas)).toEqual([]);
  });

  it('охраняемая территория — по тем же тегам, что у проб is_in', () => {
    expect(isProtectedArea({ boundary: 'protected_area' })).toBe(true);
    expect(isProtectedArea({ boundary: 'national_park' })).toBe(true);
    expect(isProtectedArea({ leisure: 'nature_reserve' })).toBe(true);
    expect(isProtectedArea({ boundary: 'administrative' })).toBe(false);
    expect(isProtectedArea({ natural: 'water' })).toBe(false);
  });
});

describe('скрипт сверки на выгрузке', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oopt-'));
  const feature = (id: string, tags: Record<string, string>, geometry: AreaGeometry) =>
    `\x1e${JSON.stringify({ type: 'Feature', id, properties: tags, geometry })}`;
  const run = (lines: string[], places: unknown[]) => {
    const areas = join(dir, `a-${Math.random()}.geojsonseq`);
    const marker = join(dir, `m-${Math.random()}.json`);
    const out = join(dir, `o-${Math.random()}.json`);
    writeFileSync(areas, lines.join('\n'));
    writeFileSync(marker, JSON.stringify({ places }));
    try {
      const stdout = execFileSync('npx', ['tsx', 'scripts/oopt-contours.ts', areas, marker, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout, result: JSON.parse(readFileSync(out, 'utf8')) as { places: Array<{ id: string; areas: Array<{ name: string; osm: string }> | null }> } };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, stdout: err.stdout + err.stderr, result: null };
    }
  };

  it('называет контуры каждой точки; чужие теги не считаются', () => {
    const r = run([
      feature('r1', { boundary: 'protected_area', name: 'Парк', protect_class: '2' }, PARK),
      feature('w2', { boundary: 'protected_area', name: 'Памятник', protection_title: 'Памятник природы' }, MONUMENT),
      feature('r3', { boundary: 'administrative', name: 'Район' }, PARK),
    ], [
      { id: 'p-monument', name: 'У памятника', lat: 53.3, lng: 158.3, zone: 'none' },
      { id: 'p-outside', name: 'Снаружи', lat: 52, lng: 157, zone: null },
      { id: 'p-nopoint', name: 'Без точки', lat: null, lng: null },
    ]);
    expect(r.code).toBe(0);
    const by = Object.fromEntries(r.result!.places.map((p) => [p.id, p.areas]));
    expect(by['p-monument']!.map((a) => a.name)).toEqual(['Памятник', 'Парк']);
    expect(by['p-monument']!.map((a) => a.osm)).toEqual(['w2', 'r1']);
    expect(by['p-outside']).toEqual([]);
    expect(by['p-nopoint']).toBeNull();
    expect(r.stdout).toMatch(/контуров охраняемых территорий 2, мест в маркере 3/);
    expect(r.stdout).toMatch(/Итог: мест 3, внутри хотя бы одного контура 1, вне всех 1, без точки 1/);
    expect(r.stdout).not.toMatch(/Район/);
  }, 60_000);

  it('ноль контуров в выгрузке — выход 1, а не «ни одной территории»', () => {
    const r = run([feature('r3', { boundary: 'administrative', name: 'Район' }, PARK)], [{ id: 'p', name: 'Место', lat: 53.3, lng: 158.3 }]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Ноль контуров на весь край/);
  }, 60_000);

  it('битая строка выгрузки — выход 1: список контуров неполон', () => {
    const r = run([feature('r1', { boundary: 'protected_area', name: 'Парк' }, PARK), '\x1e{битая'], [{ id: 'p', name: 'Место', lat: 53.3, lng: 158.3 }]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/нечитаемых строк/);
  }, 60_000);
});
