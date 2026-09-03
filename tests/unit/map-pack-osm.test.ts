/**
 * OSM-слои пакета (02.09, третий шаг итерации «го»): вода, реки, лес,
 * ледники, тропы, дороги, вершины — с раннера через Overpass.
 *
 * Стиль с 31.08 честно писал: рек, леса и троп нет — источник недостижим из
 * контейнера сборки. Раннер ходит свободно, и конвейер пакета исполняется
 * на нём. Сторож держит то, что разъезжается молча между Python-конвейером,
 * контрактом пакета, стилем, заливкой и workflow:
 *   - список слоёв один (LAYERS в build_osm.py = OSM_LAYERS);
 *   - адреса слоёв выдаются только районам из OSM_BUILT_REGIONS (обещание);
 *   - стиль создаёт OSM-слои только при адресах и валиден в обоих случаях;
 *   - тропа с OSM — пунктир (§12: не наш снятый трек);
 *   - заливка — все семь или ни одного;
 *   - атрибуция ODbL у каждого источника.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
  OSM_LAYERS, OSM_BUILT_REGIONS, osmKey, resolvePackSource, type OsmLayer,
} from '@/lib/map/pack-source';
import { buildVedarStyle } from '@/lib/map/vedar-style';

const ROOT = process.cwd();
const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_osm.py'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-build.yml'), 'utf-8');
const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-pack.ts'), 'utf-8');

const base = 'https://s3.example.ru/b';
const allUrls = Object.fromEntries(OSM_LAYERS.map((l) => [l, `${base}/map-packs/avacha-group.osm.${l}.geojson`])) as Record<OsmLayer, string>;
const baseSources = { terrainUrl: 'pmtiles://x', contoursUrl: 'y', terrainMaxZoom: 13, attribution: 'a' };
type Style = { sources: Record<string, { attribution?: string }>; layers: Array<{ id: string; type: string; source?: string; paint?: Record<string, unknown> }> };

describe('список слоёв — один на конвейер и контракт', () => {
  it('LAYERS в build_osm.py совпадает с OSM_LAYERS', () => {
    // Комментарии снимаются ДО поиска скобки: скобка внутри комментария
    // обрывала бы кортеж на середине (02.09, «(горячий — ожог)»).
    const stripped = PY.replace(/#[^\n]*/g, '');
    const m = stripped.match(/^LAYERS = \(([\s\S]*?)\)/m);
    expect(m, 'LAYERS в build_osm.py не найден').toBeTruthy();
    const py = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(py).toEqual([...OSM_LAYERS]);
  });

  it('покрытия и опасности — третьим запросом со своим кэшем, не в тяжёлом', () => {
    // «От этого зависят жизни людей» (владелец 02.09): стланик и болото —
    // непроходимость, обрыв, брод и источник — факты, по которым ступают.
    expect(PY).toContain('def landcover_query(');
    expect(PY).toMatch(/prefix=f'landcover_\{lc_sig\}'/);
    const heavy = PY.slice(PY.indexOf('def overpass_query('), PY.indexOf('def symbols_query('));
    for (const t of ['scrub', 'cliff', 'ford', 'spring']) expect(heavy).not.toContain(t);
    const lc = PY.slice(PY.indexOf('def landcover_query('), PY.indexOf('def fetch_symbols('));
    for (const t of ['scrub', 'wetland', 'cliff', '"ford"="yes"', 'hot_spring', 'residential']) {
      expect(lc).toContain(t);
    }
    // Брод и источник — символы: контур сводится к точке.
    expect(PY).toMatch(/POINT_LAYERS = \{[^}]*'fords', 'springs'\}/);
  });

  it('ключ слоя — одна формула', () => {
    expect(osmKey('avacha-group', 'water')).toBe('map-packs/avacha-group.osm.water.geojson');
  });

  it('ноль элементов от Overpass — отказ, не пустой район', () => {
    expect(PY).toMatch(/Overpass вернул НОЛЬ элементов — отказ/);
  });
});

describe('адреса — только обещанным районам', () => {
  it('без обещания osmUrls пуст, стиль без OSM-слоёв и валиден', () => {
    const r = resolvePackSource('avacha-group', ['avacha-group'], base);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    if (!OSM_BUILT_REGIONS.includes('avacha-group')) {
      expect(r.osmUrls).toEqual({});
    }
    const style = buildVedarStyle('dark', { ...baseSources, osmUrls: {} }) as unknown as Style;
    expect(style.layers.some((l) => l.id.startsWith('osm-'))).toBe(false);
    expect(validateStyleMin(style as never)).toEqual([]);
  });

  it('с адресами — семь источников с атрибуцией ODbL, стиль валиден в обеих темах', () => {
    for (const theme of ['dark', 'light'] as const) {
      const style = buildVedarStyle(theme, {
        ...baseSources, osmUrls: allUrls,
        glyphsUrl: `${base}/map-packs/glyphs/{fontstack}/{range}.pbf`, glyphsFont: 'Noto Sans Regular',
      }) as unknown as Style;
      const errs = validateStyleMin(style as never);
      expect(errs.map((e) => e.message), `тема ${theme}`).toEqual([]);
      for (const l of OSM_LAYERS) {
        expect(style.sources[`osm-${l}`]?.attribution).toBe('© OpenStreetMap contributors');
      }
      expect(style.layers.some((l) => l.id === 'osm-peak-labels')).toBe(true);
    }
  });

  it('без глифов подписи вершин не создаются, кружки остаются', () => {
    const style = buildVedarStyle('dark', { ...baseSources, osmUrls: allUrls }) as unknown as Style;
    expect(style.layers.some((l) => l.id === 'osm-peaks')).toBe(true);
    expect(style.layers.some((l) => l.id === 'osm-peak-labels')).toBe(false);
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});

describe('порядок и вид слоёв', () => {
  const style = buildVedarStyle('dark', { ...baseSources, osmUrls: allUrls }) as unknown as Style;
  const idx = (id: string) => style.layers.findIndex((l) => l.id === id);

  it('заливки под тенью, линии над горизонталями и под маршрутом, вершины сверху', () => {
    expect(idx('osm-wood')).toBeLessThan(idx('hillshade'));
    expect(idx('osm-water')).toBeLessThan(idx('hillshade'));
    expect(idx('osm-waterways')).toBeGreaterThan(idx('contour-major'));
    expect(idx('osm-paths')).toBeLessThan(idx('route-line'));
    expect(idx('osm-peaks')).toBeGreaterThan(idx('route-connector'));
  });

  it('тропа с OSM — пунктир: не наш снятый трек (§12)', () => {
    const paths = style.layers.find((l) => l.id === 'osm-paths')!;
    expect(paths.paint!['line-dasharray']).toEqual([3, 2]);
  });
});

/**
 * Имена на карте (02.09, осмотр владельца: «на карте нет ни одного
 * названия посёлка»). Посёлок — ориентир обзорного вида; приют и перевал —
 * решения поля. Имена рек и озёр новых данных не потребовали: `name` уже
 * лежал в слоях, карта его не читала.
 */
describe('имена: посёлки, приюты, перевалы, вода', () => {
  const style = buildVedarStyle('dark', {
    ...baseSources, osmUrls: allUrls,
    glyphsUrl: `${base}/map-packs/glyphs/{fontstack}/{range}.pbf`, glyphsFont: 'Noto Sans Regular',
  }) as unknown as Style;
  const idx = (id: string) => style.layers.findIndex((l) => l.id === id);

  it('конвейер собирает три слоя-символа и спрашивает их у Overpass', () => {
    for (const l of ['places', 'shelters', 'passes'] as const) {
      expect(OSM_LAYERS).toContain(l);
    }
    expect(PY).toMatch(/node\["place"~/);
    expect(PY).toMatch(/way\["tourism"~/);      // приют бывает контуром здания
    expect(PY).toMatch(/node\["mountain_pass"="yes"\]/);
    // Символы спрашиваются ОТДЕЛЬНЫМ запросом, и его кэш ключуется
    // отпечатком запроса. Иначе кэш клеток (ключ — только координаты)
    // вернул бы ответ на прежний вопрос, и три слоя вышли бы пустыми у
    // всех десяти районов — тихо, потому что пустой слой законен.
    expect(PY).toContain('def symbols_query(');
    expect(PY).toMatch(/hashlib\.sha1\(q\.encode\('utf-8'\)\)\.hexdigest\(\)\[:8\]/);
    // Тяжёлый запрос геометрии этих тегов не спрашивает — иначе его кэш
    // тоже разъехался бы с вопросом.
    const heavy = PY.slice(PY.indexOf('def overpass_query('), PY.indexOf('def symbols_query('));
    expect(heavy).not.toContain('mountain_pass');
    expect(heavy).not.toContain('"place"');
    // Контур сводится к точке ВНУТРИ фигуры, не к центроиду.
    expect(PY).toContain('representative_point()');
    // Высота перевала — такой же факт, как высота вершины.
    expect(PY).toMatch(/layer in \('peaks', 'passes'\)/);
  });

  it('подписи есть у всех четырёх родов имён', () => {
    for (const id of ['osm-place-labels', 'osm-shelter-labels', 'osm-pass-labels',
      'osm-waterway-labels', 'osm-water-labels']) {
      expect(idx(id), id).toBeGreaterThanOrEqual(0);
    }
    expect(validateStyleMin(style as never)).toEqual([]);
  });

  it('посёлки — поверх всего, вода — под символами', () => {
    expect(idx('osm-place-labels')).toBeGreaterThan(idx('osm-peaks'));
    expect(idx('osm-waterway-labels')).toBeLessThan(idx('osm-shelters'));
  });

  it('при тесноте вытесняется хутор, а не город', () => {
    const labels = style.layers.find((l) => l.id === 'osm-place-labels') as unknown as
      { layout: Record<string, unknown> };
    expect(labels.layout['symbol-sort-key']).toEqual(
      ['match', ['get', 'kind'], 'city', 0, 'town', 1, 'village', 2, 3]);
    expect(labels.layout['text-allow-overlap']).toBe(false);
  });

  it('безымянный перевал остаётся точкой без подписи (§4.0)', () => {
    const passLabels = style.layers.find((l) => l.id === 'osm-pass-labels') as unknown as
      { filter: unknown };
    expect(passLabels.filter).toEqual(['has', 'name']);
    expect(idx('osm-passes')).toBeGreaterThanOrEqual(0);
  });

  it('обрыв — поверх троп, цветом тревоги; горячий источник — акцентом', () => {
    const ids = style.layers.map((l) => l.id);
    expect(idx('osm-cliffs')).toBeGreaterThan(idx('osm-paths'));
    expect(idx('osm-cliffs')).toBeLessThan(idx('route-trail'));
    for (const id of ['osm-scrub', 'osm-wetland', 'osm-sand', 'osm-rock', 'osm-residential']) {
      expect(idx(id), id).toBeLessThan(idx('hillshade'));
    }
    const springs = style.layers.find((l) => l.id === 'osm-springs')!;
    expect(JSON.stringify(springs.paint!['circle-color'])).toContain('hot_spring');
    expect(ids).toContain('osm-fords');
    expect(validateStyleMin(style as never)).toEqual([]);
  });

  it('без глифов подписей нет, а точки остаются и стиль валиден', () => {
    const noGlyphs = buildVedarStyle('dark', { ...baseSources, osmUrls: allUrls }) as unknown as Style;
    for (const id of ['osm-place-labels', 'osm-shelter-labels', 'osm-pass-labels', 'osm-water-labels']) {
      expect(noGlyphs.layers.some((l) => l.id === id), id).toBe(false);
    }
    expect(noGlyphs.layers.some((l) => l.id === 'osm-places')).toBe(true);
    expect(validateStyleMin(noGlyphs as never)).toEqual([]);
  });
});

describe('заливка и workflow', () => {
  it('отчёт заливки называет число объектов, а не только килобайты', () => {
    // Слой из двух посёлков весит 300 байт и печатался «0 КБ» — так же,
    // как пустой. «Мало» и «ничего» обязаны различаться (§4.0).
    expect(UP).toContain('countFeatures(body)');
    expect(UP).toMatch(/объектов, \$\{size\} Б/);
    expect(UP).toContain("return 'не разобрал'");
  });

  it('заливка — все семь слоёв или ни одного', () => {
    expect(UP).toMatch(/Нет OSM-слоёв: /);
    expect(UP).toMatch(/OSM_LAYERS\.map\(\(l\) => \(\{ layer: l/);
  });

  it('workflow строит OSM-слои и передаёт префикс заливке', () => {
    expect(WF).toMatch(/name: OSM-слои/);
    expect(WF).toMatch(/build_osm\.py/);
    expect(WF).toMatch(/osm2geojson/);
    expect(WF).toMatch(/"\.cache\/packs\/\$\{\{ steps\.cfg\.outputs\.region \}\}"\s*$/m);
  });
});
