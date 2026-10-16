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
import { districtCensus, type DistrictInfo, type DistrictPlace } from '@/lib/places/district-census';
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
    P('в-море', 52.00, 160.50, 'avachinsky'),
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

  it('Командоры — дальний округ: тревоги по координате, район их не решает', () => {
    expect(r.far.map((p) => p.id)).toEqual(['беринг']);
  });

  it('округ, которого не знает карта МЧС, называется отдельно — не «совпало» и не «расходится»', () => {
    expect(r.district_unmapped.map((p) => [p.id, p.district])).toEqual([['палана', 'городской округ Палана']]);
  });

  it('вне округов и без точки — свои исходы, а не «совпало»', () => {
    expect(r.no_district.map((p) => p.id)).toEqual(['в-море']);
    expect(r.no_point.map((p) => p.id)).toEqual(['без-точки']);
    expect(r.places).toBe(8);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(8);
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
    ], { ok: true, place_rows: [P('эссо', 55.93, 158.70, 'avachinsky'), P('море', 52.0, 160.5, 'avachinsky')] });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Округов в выгрузке: 1; мест: 2/);
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
