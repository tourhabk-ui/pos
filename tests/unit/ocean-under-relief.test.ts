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
  buildVedarStyle, buildRegionOverlay, vedarMapPalette, OCEAN_UNDER_PREFIX, OCEAN_VOID_PREFIX, oceanUnderAnchor,
  neighborLayerAnchor, OVERVIEW_LAYER_MAXZOOM, type VedarStyleSources,
} from '@/lib/map/vedar-style';
import { PACK_TERRAIN_MAXZOOM, OVERVIEW_MAX_ZOOM } from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const ROOT = process.cwd();
type Layer = { id: string; type: string; source?: string; minzoom?: number; maxzoom?: number; filter?: unknown; paint?: Record<string, unknown> };
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

  it('карта и снимки ставят слои соседа одним правилом — neighborLayerAnchor', () => {
    const vm = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
    expect(vm).toMatch(/const before = neighborLayerAnchor\(layer, region, map\.getLayersOrder\(\)\);/);
    const snap = readFileSync(join(ROOT, 'scripts/map-tiles/snapshot-packs.ts'), 'utf-8');
    expect(snap).toMatch(/const before = neighborLayerAnchor\(layer, region, style\.layers\.map/);
    expect(snap).toMatch(/if \(at >= 0\) style\.layers\.splice\(at, 0, layer\);/);
  });
});

describe('квадраты без DEM: вода поверх тени (рамка по морю, 24.09)', () => {
  // Кадры снимков после подложки воды: море синее, но по нему тонкая тёмная
  // рамка ровно по целым градусам (159° в. д., 53° и 51° с. ш.) — края
  // квадратов, для которых Copernicus тайла не публикует. Внутри «нет
  // данных» (-500 м), снаружи море 0 м — тень рисует обрыв.
  const layers = () => (buildVedarStyle('dark', OVERVIEW) as { layers: Layer[] }).layers;

  it('заливка есть при адресе океана, с z8, только объекты kind=void, цвет воды', () => {
    const v = layers().find((l) => l.id === OCEAN_VOID_PREFIX);
    expect(v?.type).toBe('fill');
    expect(v?.source).toBe('vedar-ocean');
    expect(v?.minzoom).toBe(OVERVIEW_LAYER_MAXZOOM);
    expect(v?.maxzoom).toBeUndefined();
    expect(v?.filter).toEqual(['==', ['get', 'kind'], 'void']);
    expect(v?.paint?.['fill-color']).toBe(vedarMapPalette('dark').water);
    const bare = (buildVedarStyle('dark', { ...OVERVIEW, oceanUrl: null }) as { layers: Layer[] }).layers;
    expect(bare.some((l) => l.id.startsWith(OCEAN_VOID_PREFIX))).toBe(false);
  });

  it('океан и подложка берут только kind=ocean — квадраты не рисуются дважды разными правилами', () => {
    for (const id of ['vedar-ocean', OCEAN_UNDER_PREFIX]) {
      expect(layers().find((l) => l.id === id)?.filter, id).toEqual(['==', ['get', 'kind'], 'ocean']);
    }
  });

  it('в основном стиле — над тенью', () => {
    const ids = layers().map((l) => l.id);
    expect(ids.indexOf(OCEAN_VOID_PREFIX)).toBeGreaterThan(ids.indexOf('hillshade'));
    expect(ids.indexOf(OCEAN_VOID_PREFIX)).toBeGreaterThan(ids.indexOf('relief'));
  });

  it('подкладка соседа: тень и гипсометрия клетки, пришедшие ПОСЛЕ обзора, встают под заливку', () => {
    // Основной стиль — клетка; сначала подкладывается обзор, потом соседняя клетка.
    const ids = (buildVedarStyle('dark', CELL) as { layers: Layer[] }).layers.map((l) => l.id);
    const add = (layer: { id: string; type: string }, region: string) => {
      const before = neighborLayerAnchor(layer, region, ids);
      const at = before ? ids.indexOf(before) : -1;
      if (at >= 0) ids.splice(at, 0, layer.id); else ids.push(layer.id);
    };
    for (const l of buildRegionOverlay('dark', OVERVIEW, OVERVIEW_ID, 'base').layers) add(l as never, OVERVIEW_ID);
    for (const l of buildRegionOverlay('dark', CELL, 'cell-50n158e', 'base').layers) add(l as never, 'cell-50n158e');
    const v = ids.indexOf(`${OCEAN_VOID_PREFIX}-${OVERVIEW_ID}`);
    expect(v).toBeGreaterThan(0);
    for (const id of ['relief-cell-50n158e', 'hillshade-cell-50n158e', 'relief', 'hillshade', `hillshade-${OVERVIEW_ID}`]) {
      expect(ids.indexOf(id), id).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(id), id).toBeLessThan(v);
    }
    // Подложка — сразу над фоном; маршрут — над всем этим.
    expect(ids.indexOf(`${OCEAN_UNDER_PREFIX}-${OVERVIEW_ID}`)).toBe(ids.indexOf('bg') + 1);
    expect(ids.indexOf('route-trail')).toBeGreaterThan(v);
  });

  it('прочие заливки соседа — под его тень, как прежде; сама заливка квадратов — нет', () => {
    const ids = ['bg', 'relief', 'hillshade-r', 'route-trail'];
    expect(neighborLayerAnchor({ id: 'osm-forest-r', type: 'fill' }, 'r', ids)).toBe('hillshade-r');
    expect(neighborLayerAnchor({ id: `${OCEAN_VOID_PREFIX}-r`, type: 'fill' }, 'r', ids)).toBe('route-trail');
    expect(neighborLayerAnchor({ id: 'contour-r', type: 'line' }, 'r', ids)).toBe('route-trail');
  });
});

describe('квадраты без DEM: сборщик и заливка', () => {
  const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_ocean.py'), 'utf-8');
  const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-ocean.ts'), 'utf-8');

  it('список — у самого Copernicus, тем же бакетом, что читает рельеф', () => {
    const terrain = readFileSync(join(ROOT, 'scripts/map-tiles/build_terrain.py'), 'utf-8');
    const bucket = terrain.match(/^DEM_BUCKET = '([^']+)'/m)?.[1];
    expect(bucket).toBeTruthy();
    expect(PY).toContain(`DEM_TILE_LIST_URL = '${bucket}/tileList.txt'`);
  });

  it('имя тайла — той же формулы, что у сборщика рельефа (иначе «пустым» стал бы каждый квадрат)', () => {
    expect(PY).toMatch(/f'Copernicus_DSM_COG_10_\{ns\}\{abs\(lat\):02d\}_00_\{ew\}\{abs\(lng\):03d\}_00_DEM'/);
    const terrain = readFileSync(join(ROOT, 'scripts/map-tiles/build_terrain.py'), 'utf-8');
    expect(terrain).toMatch(/^DEM_RES_CODE = '10'$/m);
  });

  it('квадраты пересекаются с океаном OSM — раздутый край не ложится на сушу соседа', () => {
    expect(PY).toMatch(/\]\)\.intersection\(ocean_full\)/);
    expect(PY).toMatch(/'kind': 'void'/);
  });

  it('не скачался, не похож, пуст — отказ сборки, а не файл без квадратов', () => {
    expect(PY).toMatch(/ОТКАЗ: список тайлов Copernicus не скачался/);
    expect(PY).toMatch(/len\(names\) < 20000 or DEM_TILE_CONTROL not in names/);
    expect(PY).toMatch(/ОТКАЗ: в рамке с морем по трём сторонам нет ни одного квадрата без DEM/);
  });

  it('заливка в хранилище требует объект kind=void', () => {
    expect(UP).toMatch(/voids\.length !== 1 \|\| !polygonal\(voids\[0\]\)/);
  });
});
