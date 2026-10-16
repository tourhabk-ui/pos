// @vitest-environment node
/**
 * Перепись районов: район места против округа его точки (16.10, #83).
 *
 * Вызовом правила на контурах-квадратах и настоящем разборе приёма
 * (mchs_zones): место дойдёт до тревоги МЧС о своём округе, только если
 * его район назван той же зоной. Случаи — из переписи 15.10: Эссо с
 * районом «avachinsky» в Быстринском округе, Командоры, Палана.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { districtCensus, NEAR_SHORE_KM, type DistrictInfo, type DistrictPlace } from '@/lib/places/district-census';
import type { Area } from '@/lib/geo/point-in-area';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';

function square(name: string, minLat: number, maxLat: number, minLng: number, maxLng: number): Area<DistrictInfo> {
  return {
    geometry: {
      type: 'Polygon',
      coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
    },
    info: { name, osm: `relation ${name.length}` },
  };
}

const DISTRICTS = [
  square('Елизовский район', 52.5, 53.5, 157.5, 159.5),
  square('Быстринский муниципальный округ', 55.5, 56.5, 158.0, 159.5),
  square('Алеутский муниципальный округ', 54.3, 55.6, 165.5, 168.2),
  square('городской округ Палана', 59.0, 59.2, 159.9, 160.2),
  // Парамушир — Сахалинская область: тревоги МЧС Камчатки его не называют.
  square('Северо-Курильский муниципальный округ', 50.0, 51.0, 155.0, 156.5),
];

const P = (id: string, lat: number | null, lng: number | null, zone: string | null): DistrictPlace => ({ id, name: id, lat, lng, zone });

describe('сличение района с округом точки', () => {
  const r = districtCensus([
    P('эссо-1', 55.93, 158.70, 'avachinsky'),
    P('эссо-2', 55.92, 158.69, 'avachinsky'),
    P('паратунка', 52.95, 158.25, 'avachinsky'),
    P('апапель', 56.32, 159.24, null),
    P('беринг', 55.20, 166.00, 'commander'),
    P('палана', 59.08, 159.95, 'northern'),
    P('эбеко', 50.69, 156.01, 'avachinsky'),
    P('в-море', 52.00, 160.50, 'avachinsky'),
    // Бухта в 3,4 км от восточного края елизовского квадрата.
    P('бухта', 52.98, 159.55, null),
    P('без-точки', null, null, 'avachinsky'),
  ], DISTRICTS, mchs_zones);

  it('район той же зоной, что тревога о его округе, — совпадение', () => {
    expect(r.counts.match).toBe(1);
  });

  it('Эссо с «avachinsky» в Быстринском — расхождение одним блоком, с прежним районом и округом', () => {
    const essoBlock = r.mismatch_blocks.find((b) => b.district === 'Быстринский муниципальный округ' && b.from === 'avachinsky');
    expect(essoBlock?.to).toBe('western');
    expect(essoBlock?.places.map((p) => p.id).sort()).toEqual(['эссо-1', 'эссо-2']);
    const nullBlock = r.mismatch_blocks.find((b) => b.from === null);
    expect(nullBlock?.places.map((p) => p.id)).toEqual(['апапель']);
    expect(r.counts.mismatch).toBe(3);
    // Крупный блок — первым.
    expect(r.mismatch_blocks[0].count).toBe(2);
  });

  it('Командоры и Палана — дальний округ: тревоги по координате, район их не решает', () => {
    expect(r.far.map((p) => p.id)).toEqual(['беринг', 'палана']);
  });

  it('округ, которого не знает карта МЧС, называется отдельно — не «совпало» и не «расходится»', () => {
    expect(r.district_unmapped.map((p) => [p.id, p.district])).toEqual([['эбеко', 'Северо-Курильский муниципальный округ']]);
  });

  it('вне округов и без точки — свои исходы, а не «совпало»', () => {
    expect(r.no_district.map((p) => p.id)).toEqual(['в-море', 'бухта']);
    expect(r.no_point.map((p) => p.id)).toEqual(['без-точки']);
    expect(r.places).toBe(10);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('точка в воде у берега называет ближайший округ и расстояние; в открытом море — берега нет', () => {
    const bay = r.no_district.find((p) => p.id === 'бухта');
    expect(bay?.nearest?.district).toBe('Елизовский район');
    expect(bay?.nearest?.km).toBeGreaterThan(3.2);
    expect(bay?.nearest?.km).toBeLessThan(3.5);
    // Зона ближайшего округа — по тому же разбору приёма, своей карты нет.
    expect(bay?.nearest?.expected).toEqual(mchs_zones('Елизовский район'));
    // До елизовского квадрата отсюда ~88 км — дальше радиуса берега.
    expect(r.no_district.find((p) => p.id === 'в-море')?.nearest).toBeNull();
    expect(NEAR_SHORE_KM).toBe(15);
    // У точки внутри округа ближайшего берега не спрашивают.
    expect(r.mismatch_blocks.flatMap((b) => b.places).every((p) => p.nearest === null)).toBe(true);
  });

  it('два берега в радиусе — называется ближайший, а не первый в выгрузке', () => {
    const strait = districtCensus([P('пролив', 53.2, 158.57, null)], [
      square('Елизовский район', 53.0, 53.5, 158.0, 158.5),
      square('городской округ Петропавловск-Камчатский', 53.0, 53.5, 158.6, 159.0),
    ], mchs_zones);
    // До первого 0,07° по долготе (~4,7 км), до второго 0,03° (~2 км).
    expect(strait.no_district[0].nearest?.district).toBe('городской округ Петропавловск-Камчатский');
    expect(strait.no_district[0].nearest?.km).toBeLessThan(2.1);
  });
});

describe('скрипт переписи на выгрузке', () => {
  const dir = mkdtempSync(join(tmpdir(), 'districts-'));
  const feature = (id: string, tags: Record<string, string>, d: Area<DistrictInfo>) =>
    `\x1e${JSON.stringify({ type: 'Feature', id, properties: tags, geometry: d.geometry })}`;
  const run = (lines: string[], census: unknown) => {
    const areas = join(dir, `a-${Math.random()}.geojsonseq`);
    const file = join(dir, `c-${Math.random()}.json`);
    const out = join(dir, `o-${Math.random()}.json`);
    writeFileSync(areas, lines.join('\n'));
    writeFileSync(file, JSON.stringify(census));
    try {
      const stdout = execFileSync('npx', ['tsx', 'scripts/place-districts.ts', areas, file, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, stdout: err.stdout + err.stderr };
    }
  };

  it('округа — только admin_level 6; расхождение — блоком с номером отношения OSM', () => {
    const r = run([
      // osmium нумерует площади сам: из отношения 1234 — a2469.
      feature('a2469', { boundary: 'administrative', admin_level: '6', name: 'Быстринский муниципальный округ' }, DISTRICTS[1]),
      feature('a11', { boundary: 'administrative', admin_level: '4', name: 'Камчатский край' }, square('край', 50, 65, 155, 175)),
    ], { ok: true, place_rows: [P('эссо', 55.93, 158.70, 'avachinsky'), P('море', 52.0, 160.5, 'avachinsky'), P('озеро-у-края', 56.0, 159.6, null)] });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Округов в выгрузке: 1; мест: 3/);
    expect(r.stdout).toMatch(/море .*берега в 15 км нет/);
    expect(r.stdout).toMatch(/озеро-у-края .*берег: округ «Быстринский муниципальный округ» \(relation 1234\) в 6\.\d км → зона western/);
    expect(r.stdout).toMatch(/— avachinsky → western \(Быстринский муниципальный округ\): 1/);
    expect(r.stdout).toMatch(/эссо .*округ «Быстринский муниципальный округ» \(relation 1234\)/);
    expect(r.stdout).not.toMatch(/Камчатский край/);
  }, 60_000);

  it('маршрут без своей зоны — своим разделом, с зонами, по которым его находит тревога', () => {
    const r = run([
      feature('a2469', { boundary: 'administrative', admin_level: '6', name: 'Быстринский муниципальный округ' }, DISTRICTS[1]),
    ], {
      ok: true,
      place_rows: [P('эссо', 55.93, 158.70, 'western')],
      route_rows: [{ ...P('тропа-эссо', 55.92, 158.69, null), effective_zones: null }],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Округов в выгрузке: 1; мест: 1; маршрутов: 1/);
    const routes = r.stdout.split('══ МАРШРУТЫ')[1] ?? '';
    expect(routes).toMatch(/— без района → western \(Быстринский муниципальный округ\): 1/);
    expect(routes).toMatch(/тропа-эссо .*тревоги по зонам: ни одной/);
    expect(r.stdout.split('══ МАРШРУТЫ')[0]).toMatch(/Совпало 1, расходится 0/);
  }, 60_000);

  it('ноль округов или ноль мест — выход 1: поломка, а не «расхождений нет»', () => {
    const noDistricts = run([], { ok: true, place_rows: [P('эссо', 55.93, 158.70, 'avachinsky')] });
    expect(noDistricts.code).toBe(1);
    expect(noDistricts.stdout).toMatch(/ПЕРЕПИСЬ НЕ УДАЛАСЬ: округов 0, мест 1/);
    const noPlaces = run([feature('a2469', { boundary: 'administrative', admin_level: '6', name: 'Елизовский район' }, DISTRICTS[0])], { ok: true });
    expect(noPlaces.code).toBe(1);
  }, 60_000);
});
