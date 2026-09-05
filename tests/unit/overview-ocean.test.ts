/**
 * Океан обзорного яруса (05.09): берег — от OSM, не от нуля высоты.
 *
 * Сторож держит: слой есть ровно при адресе и только у обзора; ложится
 * сразу над гипсометрией и под тенью; цвет — воды палитры (стык ярусов
 * z7/z8 без шва); сборщик отказывает, а не пишет пустой океан; заливка
 * проверяет файл; workflow зовёт оба скрипта; проверка хранилища знает ключ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVedarStyle, buildRegionOverlay, vedarMapPalette } from '@/lib/map/vedar-style';
import {
  oceanKey, OVERVIEW_OCEAN_BUILT, OVERVIEW_BUILT, OVERVIEW_MIN_ZOOM, resolvePackSource, BUILT_PACK_REGIONS, BUILT_GRID_CELLS,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';
import { packKeysToVerify } from '@/scripts/map-tiles/verify-packs';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const ROOT = process.cwd();
const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_ocean.py'), 'utf-8');
const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-ocean.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-overview-ocean.yml'), 'utf-8');
const B = 'https://s3.example.ru/b';
type Layer = { id: string; type: string; source?: string; paint?: Record<string, unknown> };
const SRC = {
  terrainUrl: 'pmtiles://https://example.test/map-packs/krai-overview.terrain.pmtiles',
  contoursUrl: 'https://example.test/map-packs/krai-overview.contours.geojson',
  terrainMaxZoom: 7,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: null,
  oceanUrl: 'https://example.test/map-packs/krai-overview.ocean.geojson',
};

describe('слой океана в стиле', () => {
  it('есть адрес — есть источник с атрибуцией OSM и заливка; нет — ничего', () => {
    const style = buildVedarStyle('dark', SRC) as { sources: Record<string, { attribution?: string }>; layers: Layer[] };
    expect(style.sources['vedar-ocean']?.attribution).toBe('© OpenStreetMap contributors');
    expect(style.layers.find((l) => l.id === 'vedar-ocean')?.type).toBe('fill');
    const bare = buildVedarStyle('dark', { ...SRC, oceanUrl: null }) as { sources: Record<string, unknown>; layers: Layer[] };
    expect(bare.sources['vedar-ocean']).toBeUndefined();
    expect(bare.layers.some((l) => l.id === 'vedar-ocean')).toBe(false);
  });

  it('лежит сразу над тенью: швы DEM на стыках клеток не рисуются через море', () => {
    const ids = (buildVedarStyle('light', SRC) as { layers: Layer[] }).layers.map((l) => l.id);
    expect(ids.indexOf('vedar-ocean')).toBe(ids.indexOf('hillshade') + 1);
    expect(ids.indexOf('vedar-ocean')).toBeGreaterThan(ids.indexOf('relief'));
  });

  it('карта не уходит ниже обзорного яруса: OVERVIEW_MIN_ZOOM = MINZOOM обзора, minZoom у VedarMap', () => {
    const py = readFileSync(join(ROOT, 'scripts/map-tiles/build_overview.py'), 'utf-8');
    expect(Number(py.match(/^MINZOOM = (\d+)$/m)?.[1])).toBe(OVERVIEW_MIN_ZOOM);
    const vm = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
    expect(vm).toMatch(/minZoom: OVERVIEW_MIN_ZOOM/);
  });

  it('цвет — воды палитры, чтобы стык z7/z8 был без шва', () => {
    for (const theme of ['dark', 'light'] as const) {
      const layer = (buildVedarStyle(theme, SRC) as { layers: Layer[] }).layers.find((l) => l.id === 'vedar-ocean');
      expect(layer?.paint?.['fill-color']).toBe(vedarMapPalette(theme).water);
      expect(layer?.paint?.['fill-opacity']).toBe(1);
    }
  });

  it('подкладка обзора (base) несёт океан под своим пространством имён', () => {
    const base = buildRegionOverlay('dark', SRC, OVERVIEW_ID, 'base');
    const ids = base.layers.map((l) => String(l.id));
    expect(ids.indexOf(`vedar-ocean-${OVERVIEW_ID}`)).toBe(ids.indexOf(`hillshade-${OVERVIEW_ID}`) + 1);
    expect(Object.keys(base.sources)).toContain(`vedar-ocean-${OVERVIEW_ID}`);
  });

  it('обе темы валидны по спецификации с океаном и без', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const oceanUrl of [SRC.oceanUrl, null]) {
        const errors = validateStyleMin(buildVedarStyle(theme, { ...SRC, oceanUrl }) as never);
        expect(errors.map((e) => e.message)).toEqual([]);
      }
    }
  });
});

describe('ключ, обещание, проверка', () => {
  it('одна формула ключа; адрес — только у обзора и только по флагу', () => {
    expect(oceanKey(OVERVIEW_ID)).toBe(`map-packs/${OVERVIEW_ID}.ocean.geojson`);
    if (OVERVIEW_BUILT) {
      const o = resolvePackSource(OVERVIEW_ID, BUILT_PACK_REGIONS, B);
      expect(o.state).toBe('ready');
      if (o.state === 'ready') expect(o.oceanUrl !== null).toBe(OVERVIEW_OCEAN_BUILT);
    }
    for (const id of [...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS]) {
      const r = resolvePackSource(id, BUILT_PACK_REGIONS, B);
      if (r.state === 'ready') expect(r.oceanUrl, id).toBeNull();
    }
  });

  it('проверка хранилища знает ключ ровно по флагу', () => {
    const keys = packKeysToVerify().map((k) => k.key);
    expect(keys.includes(oceanKey(OVERVIEW_ID))).toBe(OVERVIEW_BUILT && OVERVIEW_OCEAN_BUILT);
  });
});

describe('сборщик и заливка — отказ, не пустой океан', () => {
  it('кольца — по RFC 7946: orient() и проверка is_ccw, не предположение', () => {
    // 05.09: без этого суша красилась морем — MapLibre судит по знаку площади.
    expect(PY).toMatch(/from shapely\.geometry\.polygon import orient/);
    expect(PY).toMatch(/orient\(pg, 1\.0\)/);
    expect(PY).toMatch(/pg\.exterior\.is_ccw/);
  });

  it('заливка океана — только на обзорных зумах (maxzoom 8)', () => {
    const layer = (buildVedarStyle('dark', SRC) as { layers: Array<Layer & { maxzoom?: number }> }).layers.find((l) => l.id === 'vedar-ocean');
    expect(layer?.maxzoom).toBe(8);
  });

  it('build_ocean.py отказывает без суши и при неправдоподобной доле', () => {
    expect(PY).toMatch(/ни один полигон суши не пересёк bbox/);
    expect(PY).toMatch(/land_share < 0\.05 or land_share > 0\.95/);
    expect(PY).toMatch(/simplified-land-polygons-complete-3857/);
    expect(PY).toMatch(/'kind': 'ocean'/);
  });

  it('upload-ocean.ts проверяет файл и заливает под ключ обзора', () => {
    expect(UP).toMatch(/f\.properties\?\.kind !== 'ocean'/);
    expect(UP).toMatch(/uploadToS3\(oceanKey\(OVERVIEW_ID\)/);
  });

  it('workflow зовёт сборщик, заливку и bbox из реестра', () => {
    expect(WF).toContain('scripts/map-tiles/build_ocean.py');
    expect(WF).toContain('scripts/map-tiles/upload-ocean.ts');
    expect(WF).toContain('region-bbox.ts krai-overview');
    expect(WF).toContain('.github/triggers/map-overview-ocean.json');
  });
});
