/**
 * Вода под рельефом с z8 (24.09, скрин владельца «закрась море», зум 8.8,
 * тёмная тема): серый прямоугольник посреди океана к востоку от южного
 * берега. Обзорная заливка океана кончается на z8, а у клеток над открытым
 * морем тайлов DEM нет — сквозь прозрачную клетку проступал фон «не знаю».
 *
 * Сторож держит:
 *   1. подложка есть ровно при адресе океана, с z8 и без верхнего предела —
 *      встык с обзорной заливкой, без зума, где моря нет ни у кого;
 *   2. она ПОД всем рельефом: сразу над фоном в основном стиле, и туда же её
 *      ставят карта и снимки, когда она приходит подкладкой соседа позже
 *      рельефа клеток — иначе вода закрыла бы сушу;
 *   3. цвет — воды палитры, источник — тот же файл океана (второй файл не
 *      качается).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildVedarStyle, buildRegionOverlay, vedarMapPalette, OCEAN_UNDER_PREFIX, oceanUnderAnchor,
  OVERVIEW_LAYER_MAXZOOM, type VedarStyleSources,
} from '@/lib/map/vedar-style';
import { PACK_TERRAIN_MAXZOOM, OVERVIEW_MAX_ZOOM } from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const ROOT = process.cwd();
type Layer = { id: string; type: string; source?: string; minzoom?: number; maxzoom?: number; paint?: Record<string, unknown> };
const OVERVIEW: VedarStyleSources = {
  terrainUrl: 'pmtiles://https://example.test/map-packs/krai-overview.terrain.pmtiles',
  contoursUrl: 'https://example.test/map-packs/krai-overview.contours.geojson',
  terrainMaxZoom: OVERVIEW_MAX_ZOOM,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: null,
  oceanUrl: 'https://example.test/map-packs/krai-overview.ocean.geojson',
};
const CELL: VedarStyleSources = {
  terrainUrl: 'pmtiles://https://example.test/map-packs/cell-51n157e.terrain.pmtiles',
  contoursUrl: 'https://example.test/map-packs/cell-51n157e.contours.geojson',
  terrainMaxZoom: PACK_TERRAIN_MAXZOOM,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: null,
  oceanUrl: null,
};

describe('подложка воды в стиле', () => {
  it('есть адрес океана — есть подложка; нет — нет', () => {
    const style = buildVedarStyle('dark', OVERVIEW) as { layers: Layer[] };
    expect(style.layers.some((l) => l.id === OCEAN_UNDER_PREFIX)).toBe(true);
    const bare = buildVedarStyle('dark', { ...OVERVIEW, oceanUrl: null }) as { layers: Layer[] };
    expect(bare.layers.some((l) => l.id.startsWith(OCEAN_UNDER_PREFIX))).toBe(false);
  });

  it('встык с обзорной заливкой: подложка с z8 без верха, заливка до z8', () => {
    const layers = (buildVedarStyle('dark', OVERVIEW) as { layers: Layer[] }).layers;
    const under = layers.find((l) => l.id === OCEAN_UNDER_PREFIX);
    const over = layers.find((l) => l.id === 'vedar-ocean');
    expect(under?.minzoom).toBe(OVERVIEW_LAYER_MAXZOOM);
    expect(under?.maxzoom).toBeUndefined();
    expect(over?.maxzoom).toBe(under?.minzoom);
  });

  it('тот же файл и цвет воды палитры в обеих темах', () => {
    for (const theme of ['dark', 'light'] as const) {
      const layers = (buildVedarStyle(theme, OVERVIEW) as { layers: Layer[] }).layers;
      const under = layers.find((l) => l.id === OCEAN_UNDER_PREFIX);
      expect(under?.type).toBe('fill');
      expect(under?.source).toBe('vedar-ocean');
      expect(under?.paint?.['fill-color']).toBe(vedarMapPalette(theme).water);
      expect(under?.paint?.['fill-opacity']).toBe(1);
    }
  });

  it('в основном стиле — сразу над фоном, под гипсометрией и тенью', () => {
    const ids = (buildVedarStyle('light', OVERVIEW) as { layers: Layer[] }).layers.map((l) => l.id);
    expect(ids.indexOf(OCEAN_UNDER_PREFIX)).toBe(ids.indexOf('bg') + 1);
    expect(ids.indexOf(OCEAN_UNDER_PREFIX)).toBeLessThan(ids.indexOf('relief'));
    expect(ids.indexOf(OCEAN_UNDER_PREFIX)).toBeLessThan(ids.indexOf('hillshade'));
  });

  it('стиль валиден по спецификации в обеих темах', () => {
    for (const theme of ['dark', 'light'] as const) {
      const errors = validateStyleMin(buildVedarStyle(theme, OVERVIEW) as never);
      expect(errors.map((e) => e.message)).toEqual([]);
    }
  });
});

describe('подкладка соседа: вода под рельефом клетки', () => {
  it('подкладка обзора несёт подложку под своим пространством имён', () => {
    const ov = buildRegionOverlay('dark', OVERVIEW, OVERVIEW_ID, 'base');
    const under = ov.layers.find((l) => l.id === `${OCEAN_UNDER_PREFIX}-${OVERVIEW_ID}`) as Layer | undefined;
    expect(under?.source).toBe(`vedar-ocean-${OVERVIEW_ID}`);
    expect(under?.minzoom).toBe(OVERVIEW_LAYER_MAXZOOM);
  });

  it('место вставки — первый слой над фоном: клетка со своим рельефом остаётся сверху', () => {
    // Основной стиль — клетка (обычный случай на /map), обзор приходит соседом.
    const cell = buildVedarStyle('dark', CELL) as { layers: Layer[] };
    const ids = cell.layers.map((l) => l.id);
    const anchor = oceanUnderAnchor(ids);
    expect(anchor).toBe(ids[ids.indexOf('bg') + 1]);
    // Вставка перед якорем ставит воду ниже гипсометрии и тени клетки.
    const merged = [...ids];
    merged.splice(merged.indexOf(anchor as string), 0, `${OCEAN_UNDER_PREFIX}-${OVERVIEW_ID}`);
    const at = merged.indexOf(`${OCEAN_UNDER_PREFIX}-${OVERVIEW_ID}`);
    expect(at).toBe(merged.indexOf('bg') + 1);
    expect(at).toBeLessThan(merged.indexOf('relief'));
    expect(at).toBeLessThan(merged.indexOf('hillshade'));
  });

  it('без фона якорь — первый слой, а не конец списка', () => {
    expect(oceanUnderAnchor(['relief', 'hillshade'])).toBe('relief');
  });

  it('карта и снимки кладут подложку по якорю, а не поверх (одно правило на два места)', () => {
    const vm = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
    expect(vm).toMatch(/id\.startsWith\(OCEAN_UNDER_PREFIX\)\s*\n\s*\? oceanUnderAnchor\(map\.getStyle\(\)\.layers\.map/);
    const snap = readFileSync(join(ROOT, 'scripts/map-tiles/snapshot-packs.ts'), 'utf-8');
    expect(snap).toMatch(/String\(layer\.id\)\.startsWith\(OCEAN_UNDER_PREFIX\)\s*\n\s*\? style\.layers\.findIndex\(\(l\) => l\.id === oceanUnderAnchor\(/);
    expect(snap).toMatch(/if \(under >= 0\) style\.layers\.splice\(under, 0, layer\);/);
  });
});
