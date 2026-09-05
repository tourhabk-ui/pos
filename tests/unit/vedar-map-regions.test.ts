/**
 * Соседние районы своей карты подкладываются по видимой области.
 *
 * Скрин владельца 02.09 08:21: при отдалении виден один пакет (Авачинская
 * группа), остальные девять районов — чёрное поле, хотя все десять уже
 * лежат в хранилище. Стиль описывал один район — тот, что накрывает точку.
 *
 * Черты:
 *  1. Оверлей района — те же слои, что в основном стиле, с суффиксом района
 *     в идентификаторах; вместе с основным стилем проходит валидатор.
 *  2. Два яруса: base (рельеф + вершины) — дёшево на любом зуме; detail
 *     (горизонтали + остальной OSM) — GeoJSON целиком, только вблизи.
 *  3. Пересечение bbox района с видимой областью — чистая функция.
 *  4. Карта слушает moveend и не подкладывает основной район второй раз.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { buildVedarStyle, buildRegionOverlay } from '@/lib/map/vedar-style';
import { builtRegionPacks, regionsIntersecting } from '@/lib/map/field-base-map';
import { OSM_LAYERS, BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT } from '@/lib/map/pack-source';
import { OVERVIEW_ID, OVERVIEW_BBOX } from '@/lib/geo/regions';

const B = 'https://s3.example.ru/b';
const osm = (r: string) => Object.fromEntries(OSM_LAYERS.map(l => [l, `${B}/map-packs/${r}.osm.${l}.geojson`]));
const src = (r: string) => ({
  terrainUrl: `pmtiles://${B}/map-packs/${r}.terrain.pmtiles`,
  contoursUrl: `${B}/map-packs/${r}.contours.geojson`,
  terrainMaxZoom: 13,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: `${B}/map-packs/glyphs/{fontstack}/{range}.pbf`,
  glyphsFont: 'Noto Sans Regular',
  osmUrls: osm(r),
});

type Style = { sources: Record<string, { type: string }>; layers: Array<{ id: string; type: string; source?: string }> };

describe('оверлей района', () => {
  it('те же слои с суффиксом района, и вместе с основным стилем стиль валиден', () => {
    for (const theme of ['dark', 'light'] as const) {
      const base = buildVedarStyle(theme, src('avacha-group')) as unknown as Style;
      const b = buildRegionOverlay(theme, src('paratunka'), 'paratunka', 'base');
      const d = buildRegionOverlay(theme, src('paratunka'), 'paratunka', 'detail');
      const merged = {
        ...base,
        sources: { ...base.sources, ...b.sources, ...d.sources },
        layers: [...base.layers, ...b.layers, ...d.layers],
      };
      const errs = validateStyleMin(merged as never) as Array<{ message: string }>;
      expect(errs.map(e => e.message), theme).toEqual([]);
      for (const id of [...Object.keys(b.sources), ...Object.keys(d.sources)]) {
        expect(id.endsWith('-paratunka'), id).toBe(true);
        expect(base.sources[id]).toBeUndefined();
      }
      for (const l of [...b.layers, ...d.layers]) {
        expect(String(l.id).endsWith('-paratunka'), String(l.id)).toBe(true);
        expect(base.layers.find(x => x.id === l.id)).toBeUndefined();
      }
    }
  });

  it('base — рельеф, вершины и посёлки; detail — без рельефа и без них', () => {
    // Посёлок в базовом ярусе намеренно (02.09): на обзорном виде это
    // единственное, по чему человек понимает, куда смотрит, а файл
    // килобайтный — в отличие от горизонталей.
    const b = buildRegionOverlay('dark', src('esso-bystrinsky'), 'esso-bystrinsky', 'base');
    const types = Object.values(b.sources).map(s => (s as { type: string }).type);
    expect(types).toContain('raster-dem');
    expect(Object.keys(b.sources)).toEqual([
      'terrain-esso-bystrinsky', 'osm-peaks-esso-bystrinsky', 'osm-places-esso-bystrinsky',
    ]);
    expect(b.layers.map(l => l.id)).toEqual([
      'relief-esso-bystrinsky', 'hillshade-esso-bystrinsky',
      'osm-peaks-esso-bystrinsky', 'osm-peak-labels-esso-bystrinsky',
      'osm-places-esso-bystrinsky', 'osm-place-labels-esso-bystrinsky',
    ]);
    const d = buildRegionOverlay('dark', src('esso-bystrinsky'), 'esso-bystrinsky', 'detail');
    expect(Object.values(d.sources).every(s => (s as { type: string }).type === 'geojson')).toBe(true);
    expect(Object.keys(d.sources)).toContain('contours-esso-bystrinsky');
    expect(Object.keys(d.sources)).not.toContain('osm-peaks-esso-bystrinsky');
    expect(Object.keys(d.sources)).not.toContain('osm-places-esso-bystrinsky');
    expect(d.layers.map(l => l.id)).toContain('contour-major-esso-bystrinsky');
    // Приют и перевал — вблизи, вместе с горизонталями.
    expect(d.layers.map(l => l.id)).toContain('osm-shelters-esso-bystrinsky');
    expect(d.layers.map(l => l.id)).toContain('osm-pass-labels-esso-bystrinsky');
  });

  it('основной стиль не изменился: идентификаторы без суффикса', () => {
    const base = buildVedarStyle('dark', src('avacha-group')) as unknown as Style;
    expect(Object.keys(base.sources)).toContain('terrain');
    expect(Object.keys(base.sources)).toContain('contours');
    expect(base.layers.map(l => l.id)).toContain('hillshade');
    expect(base.layers.map(l => l.id)).toContain('osm-peaks');
  });
});

describe('какие районы в кадре', () => {
  const packs = builtRegionPacks(B);

  it('все пакеты реестра с адресами и границами', () => {
    // 03.09: клетки сетки «вся Камчатка» подкладываются следом за районами —
    // то же обещание, тот же список пакетов (builtRegionPacks).
    // 04.09: обзорный ярус края идёт ПЕРВЫМ и это намеренно — он ниже всех
    // (зумы 4-7), а карта кладёт слои в порядке этого списка.
    expect(packs.map(p => p.region)).toEqual(
      [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS],
    );
    expect(packs.every(p => p.source.terrainUrl.startsWith('pmtiles://'))).toBe(true);
    expect(builtRegionPacks(null)).toEqual([]);
  });

  it('пересечение bbox с областью: Елизово вблизи — Авачинская и Паратунка, весь край — все', () => {
    const near = regionsIntersecting(packs, { south: 53.1, west: 158.3, north: 53.3, east: 158.6 });
    expect(near).toContain('avacha-group');
    expect(near).toContain('paratunka');
    expect(near).not.toContain('klyuchevskoy');
    // 04.09: bbox «весь край» был зашит числами (north: 58) и устарел, как
    // только в реестре появились клетки Корякии (lat >= 60) — тест несколько
    // прогонов молчал бы неверно, «все» оказывались не всеми. OVERVIEW_BBOX —
    // тот же источник границ края, что у обзорного яруса; растёт вместе с
    // реестром, а не отдельным зашитым числом.
    const all = regionsIntersecting(packs, OVERVIEW_BBOX);
    expect(all.length).toBe(packs.length);
    expect(regionsIntersecting(packs, { south: 0, west: 0, north: 1, east: 1 })).toEqual([]);
  });
});

describe('карта подкладывает соседей сама', () => {
  const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
  const CLIENT = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('по moveend, ярус detail — с DETAIL_MIN_ZOOM, основной район пропускается', () => {
    expect(MAP).toMatch(/map\.on\('moveend', ensure\)/);
    expect(MAP).toMatch(/map\.off\('moveend', ensure\)/);
    // Константа живёт в стиле (снимки на раннере собирают подкладки тем же
    // правилом), компонент её реэкспортирует.
    expect(MAP).toMatch(/export \{ DETAIL_MIN_ZOOM \} from '@\/lib\/map\/vedar-style'/);
    expect(readFileSync(join(process.cwd(), 'lib/map/vedar-style.ts'), 'utf-8')).toMatch(/export const DETAIL_MIN_ZOOM = 10/);
    expect(MAP).toMatch(/zoom >= DETAIL_MIN_ZOOM \? \['base', 'detail'\] : \['base'\]/);
    expect(MAP).toMatch(/if \(region === baseRegion\) continue;/);
  });

  it('слои соседа ложатся под линию маршрута, заливки — под его тень', () => {
    expect(MAP).toMatch(/layer\.type === 'fill' && map\.getLayer\(hill\) \? hill : 'route-trail'/);
  });

  it('отказ подкладки не глотается', () => {
    expect(MAP).toMatch(/console\.error\(`\[VedarMap\] район \$\{region\} \(\$\{tier\}\) не подложился`, err\)/);
  });

  it('экран отдаёт карте все пакеты и район основы', () => {
    expect(CLIENT).toMatch(/builtRegionPacks\(mapPackBaseUrl\)/);
    expect(CLIENT).toMatch(/packs=\{regionPacks\}/);
    expect(CLIENT).toMatch(/baseRegion=\{fieldBaseMap\.region\}/);
  });
});
