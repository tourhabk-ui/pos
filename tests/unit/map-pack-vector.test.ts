/**
 * Векторный пакет района (02.09, слово владельца «мне нужна качественно
 * прорисованная карта»): горизонтали 20/100/500 м и все OSM-слои в одном
 * PMTiles, нарезанном tippecanoe по зумам.
 *
 * До этого линии лежали GeoJSON и качались целиком (16 МБ горизонталей у
 * Эссо ради одного экрана) — отсюда и шаг 100 м. Тайл читается кусками, как
 * рельеф, и несёт на каждом зуме то, что на нём видно.
 *
 * Черты:
 *  1. Список слоёв пакета — один на build_vector.sh, контракт и стиль.
 *  2. С векторным адресом стиль читает всё из одного источника через
 *     source-layer, GeoJSON-источников не создаёт и валиден; частые
 *     горизонтали — только здесь и только с z13.
 *  3. Без адреса — прежний путь по GeoJSON, слой в слой.
 *  4. Зум объекта пишется в данные (tippecanoe.minzoom), не угадывается
 *     стилем; workflow ставит tippecanoe и печёт частые горизонтали.
 *  5. Обещание VECTOR_BUILT_REGIONS — как остальные: адрес только тем, у
 *     кого файл в хранилище.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { buildVedarStyle, buildRegionOverlay } from '@/lib/map/vedar-style';
import {
  OSM_LAYERS, VECTOR_LAYERS, VECTOR_BUILT_REGIONS, vectorKey, resolvePackSource,
} from '@/lib/map/pack-source';

const ROOT = process.cwd();
const SH = readFileSync(join(ROOT, 'scripts/map-tiles/build_vector.sh'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-build.yml'), 'utf-8');
const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-pack.ts'), 'utf-8');
const PY_OSM = readFileSync(join(ROOT, 'scripts/map-tiles/build_osm.py'), 'utf-8');
const PY_CON = readFileSync(join(ROOT, 'scripts/map-tiles/build_contours.py'), 'utf-8');

const base = 'https://s3.example.ru/b';
const geo = {
  terrainUrl: 'pmtiles://x', contoursUrl: 'y', terrainMaxZoom: 13, attribution: 'a',
  glyphsUrl: `${base}/g/{fontstack}/{range}.pbf`, glyphsFont: 'Noto Sans Regular',
  osmUrls: Object.fromEntries(OSM_LAYERS.map((l) => [l, `${base}/${l}.geojson`])),
};
const vec = { ...geo, vectorUrl: `pmtiles://${base}/map-packs/avacha-group.vector.pmtiles` };

type Layer = { id: string; type: string; source?: string; 'source-layer'?: string; minzoom?: number };
type Style = { sources: Record<string, { type: string }>; layers: Layer[] };

describe('список слоёв пакета — один на конвейер и стиль', () => {
  it('build_vector.sh печёт ровно OSM_LAYERS плюс два слоя горизонталей', () => {
    const m = SH.match(/^LAYERS=\(([^)]+)\)/m);
    expect(m, 'LAYERS в build_vector.sh не найден').toBeTruthy();
    expect(m![1].trim().split(/\s+/)).toEqual([...OSM_LAYERS]);
    expect(SH).toContain('-L "contours:');
    expect(SH).toContain('-L "contours_fine:');
    expect([...VECTOR_LAYERS]).toEqual(['contours', 'contours_fine', ...OSM_LAYERS]);
  });

  it('ключ пакета — одна формула; адрес только обещанным районам', () => {
    expect(vectorKey('avacha-group')).toBe('map-packs/avacha-group.vector.pmtiles');
    const r = resolvePackSource('avacha-group', ['avacha-group'], base);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    if (VECTOR_BUILT_REGIONS.includes('avacha-group')) {
      expect(r.vectorUrl).toBe(`pmtiles://${base}/map-packs/avacha-group.vector.pmtiles`);
    } else {
      expect(r.vectorUrl).toBeNull();
    }
  });
});

describe('стиль с векторным пакетом', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: один источник, source-layer у всех линий и площадей, стиль валиден`, () => {
      const style = buildVedarStyle(theme, vec) as unknown as Style;
      const errs = validateStyleMin(style as never) as Array<{ message: string }>;
      expect(errs.map((e) => e.message)).toEqual([]);
      expect(style.sources.vector?.type).toBe('vector');
      expect(Object.keys(style.sources).filter((k) => k.startsWith('osm-'))).toEqual([]);
      expect(style.sources.contours).toBeUndefined();
      const data = style.layers.filter((l) => l.id.startsWith('osm-') || l.id.startsWith('contour-'));
      expect(data.length).toBeGreaterThan(10);
      for (const l of data) {
        expect(l.source, l.id).toBe('vector');
        expect(l['source-layer'], l.id).toBeTruthy();
        expect(VECTOR_LAYERS).toContain(l['source-layer']);
      }
    });
  }

  it('частые горизонтали — только из пакета, с z13, под сотенными', () => {
    const style = buildVedarStyle('dark', vec) as unknown as Style;
    const fine = style.layers.find((l) => l.id === 'contour-fine')!;
    expect(fine['source-layer']).toBe('contours_fine');
    expect(fine.minzoom).toBe(13);
    const ids = style.layers.map((l) => l.id);
    expect(ids.indexOf('contour-fine')).toBeLessThan(ids.indexOf('contour-minor'));
    const geoStyle = buildVedarStyle('dark', geo) as unknown as Style;
    expect(geoStyle.layers.some((l) => l.id === 'contour-fine')).toBe(false);
  });

  it('дорога получила обводку, обводка под линией', () => {
    for (const s of [vec, geo]) {
      const style = buildVedarStyle('dark', s) as unknown as Style;
      const ids = style.layers.map((l) => l.id);
      expect(ids.indexOf('osm-roads-casing')).toBeGreaterThan(0);
      expect(ids.indexOf('osm-roads-casing')).toBeLessThan(ids.indexOf('osm-roads'));
    }
  });

  it('без адреса — прежний путь по GeoJSON, слой в слой', () => {
    const style = buildVedarStyle('dark', geo) as unknown as Style;
    expect(style.sources.vector).toBeUndefined();
    expect(style.sources['osm-water']?.type).toBe('geojson');
    expect(style.layers.find((l) => l.id === 'osm-water')!.source).toBe('osm-water');
    expect(validateStyleMin(style as never)).toEqual([]);
  });

  it('оверлей соседа с пакетом: базовый ярус несёт источник, детальный — те же слои', () => {
    const b = buildRegionOverlay('dark', vec, 'paratunka', 'base');
    expect(Object.keys(b.sources)).toEqual(['terrain-paratunka', 'vector-paratunka']);
    const d = buildRegionOverlay('dark', vec, 'paratunka', 'detail');
    expect(Object.keys(d.sources)).toEqual(['vector-paratunka']);
    expect(d.layers.map((l) => l.id)).toContain('contour-fine-paratunka');
    for (const l of [...b.layers, ...d.layers]) {
      if (String(l.id).startsWith('osm-') || String(l.id).startsWith('contour-')) {
        expect(l.source).toBe('vector-paratunka');
      }
    }
  });
});

describe('конвейер', () => {
  it('зум объекта пишется в данные, не угадывается стилем', () => {
    expect(PY_OSM).toContain("'tippecanoe': {'minzoom': tile_minzoom(layer, tags)}");
    expect(PY_CON).toMatch(/'tippecanoe': \{'minzoom': TILE_MINZOOM\[kind\]\}/);
    expect(PY_CON).toMatch(/^FINE_STEP = 20$/m);
    expect(PY_CON).toContain("'fine': 13");
  });

  it('workflow ставит tippecanoe, печёт частые горизонтали и заливает пакет', () => {
    expect(WF).toMatch(/tippecanoe --version/);
    expect(WF).toContain('--fine-out');
    expect(WF).toContain('scripts/map-tiles/build_vector.sh');
    expect(WF).toMatch(/\.vector\.pmtiles"\n/);
    expect(UP).toContain('vectorKey(region as PackRegionId)');
  });
});
