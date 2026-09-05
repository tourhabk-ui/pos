/**
 * Слой мест платформы в пакете карты (05.09).
 *
 * Проверка хранилища после 112 клеток показала: у корякских клеток слои OSM
 * «тропы/приюты/посёлки» по 0.00 МБ — в OSM там пусто. Наши `places` есть и
 * там, но на офлайн-карте их не было вовсе. Слой — свой, не OSM: свой ключ,
 * свой реестр, своя атрибуция; в OSM_LAYERS ему нельзя — тот трижды прибит к
 * build_osm.py и к атрибуции OpenStreetMap (map-pack-osm.test.ts).
 *
 * Сторож держит четыре места, которые разъезжаются молча: ключ (реестр ↔
 * проверка хранилища ↔ адрес в PackSource), эндпоинт (фильтры, версия в
 * теле 401, приведение DECIMAL), конвейер (workflow зовёт именно этот роут —
 * так его видит cron-scheduler-declared), и умолчание маркера — сухой прогон.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  placesKey, PLACES_BUILT, PLACES_ATTRIBUTION, resolvePackSource,
  BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, type PackRegionId } from '@/lib/geo/regions';
import { packKeysToVerify } from '@/scripts/map-tiles/verify-packs';
import { buildVedarStyle, buildRegionOverlay } from '@/lib/map/vedar-style';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/places-export/route.ts'), 'utf-8');
const SCRIPT = readFileSync(join(ROOT, 'scripts/map-tiles/build-places.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-places-build.yml'), 'utf-8');
const MARKER = JSON.parse(readFileSync(join(ROOT, '.github/triggers/map-places-build.json'), 'utf-8')) as {
  upload?: unknown; expect_v?: unknown;
};
const B = 'https://s3.example.ru/b';
const ALL: PackRegionId[] = [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS];

describe('ключ и реестр', () => {
  it('одна формула ключа, не в OSM_LAYERS', () => {
    expect(placesKey('cell-52n157e')).toBe('map-packs/cell-52n157e.places.geojson');
    expect(placesKey(OVERVIEW_ID)).toBe(`map-packs/${OVERVIEW_ID}.places.geojson`);
  });

  it('обещание PLACES_BUILT — только о пакетах, которые существуют', () => {
    for (const id of PLACES_BUILT) expect(ALL, id).toContain(id);
  });

  it('адрес слоя в PackSource — ровно у тех, кто в PLACES_BUILT', () => {
    for (const id of ALL) {
      const r = resolvePackSource(id, BUILT_PACK_REGIONS, B);
      expect(r.state, id).toBe('ready');
      if (r.state !== 'ready') continue;
      const promised = PLACES_BUILT.includes(id);
      expect(r.placesUrl !== null, id).toBe(promised);
      if (r.placesUrl) expect(r.placesUrl).toBe(`${B}/${placesKey(id)}`);
    }
  });

  it('проверка хранилища знает про слой — по тому же реестру', () => {
    const keys = packKeysToVerify().map((k) => k.key);
    for (const id of PLACES_BUILT) expect(keys).toContain(placesKey(id));
  });

  it('атрибуция — одна строка на эндпоинт и на стиль', () => {
    expect(PLACES_ATTRIBUTION.length).toBeGreaterThan(5);
    expect(ROUTE).toMatch(/import \{ PLACES_ATTRIBUTION \} from '@\/lib\/map\/pack-source'/);
  });
});

describe('эндпоинт places-export', () => {
  it('Bearer CRON_SECRET; версия — и в теле 401, чтобы ждать деплой без секрета', () => {
    expect(ROUTE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET \?\? ''\)/);
    expect(ROUTE).toMatch(/\{ error: 'Unauthorized', v: PLACES_EXPORT_V \}, \{ status: 401 \}/);
  });

  it('только видимые, не слитые, с координатой, внутри bbox пакета', () => {
    expect(ROUTE).toMatch(/p\.is_visible = true/);
    expect(ROUTE).toMatch(/p\.merged_into_id IS NULL/);
    expect(ROUTE).toMatch(/p\.lat IS NOT NULL AND p\.lng IS NOT NULL/);
    expect(ROUTE).toMatch(/packRegionBbox\(region\)/);
  });

  it('профиль безопасности — по ark_id; DECIMAL приводится в SQL', () => {
    expect(ROUTE).toMatch(/ON sp\.agent_route_id = p\.ark_id/);
    expect(ROUTE).toMatch(/sp\.nearest_medical_km::float8/);
    expect(ROUTE).toMatch(/p\.lat::float8 AS lat, p\.lng::float8 AS lng/);
  });

  it('отказ БД — 502 и лог, не пустая коллекция', () => {
    expect(ROUTE).toMatch(/console\.error\('\[places-export\] отказ выборки'/);
    expect(ROUTE).toMatch(/\{ status: 502 \}/);
  });
});

describe('конвейер: один прогон на все пакеты, всё или ничего', () => {
  it('workflow зовёт именно этот роут и этот скрипт', () => {
    expect(WF).toContain('api/cron/places-export');
    expect(WF).toContain('scripts/map-tiles/build-places.ts');
  });

  it('скрипт держит путь литералом (по нему сторож cron-scheduler видит запускающего)', () => {
    expect(SCRIPT).toMatch(/const ENDPOINT = '\/api\/cron\/places-export'/);
  });

  it('сначала все запросы, потом все заливки — отказ до единой записи', () => {
    const fetchIdx = SCRIPT.indexOf('Фаза 1');
    const uploadIdx = SCRIPT.indexOf('Фаза 2');
    expect(fetchIdx).toBeGreaterThan(0);
    expect(uploadIdx).toBeGreaterThan(fetchIdx);
    expect(SCRIPT).toMatch(/Ничего не залито: слой либо целиком, либо никак/);
  });

  it('маркер держит явный флаг заливки и номер версии — не умолчание', () => {
    // Сам файл может стоять и в upload:true (после боевого прогона), но
    // флаг обязан быть булевым и ЯВНЫМ: workflow читает его через get(...,False),
    // и опечатка в имени ключа тихо превратила бы боевой прогон в сухой.
    expect(typeof MARKER.upload).toBe('boolean');
    expect(typeof MARKER.expect_v).toBe('number');
  });
});

/**
 * Стиль (05.09, после боевой заливки прогоном 2: 123 пакета). Слой в стиле
 * без файлов был бы обещанием, поэтому он появился ПОСЛЕ реестра, и здесь
 * стережётся именно эта связка: адрес есть — слой есть, адреса нет — слоя
 * нет, а не «серый кружок по умолчанию».
 */
type Layer = { id: string; type: string; source?: string; minzoom?: number;
  paint?: Record<string, unknown>; layout?: Record<string, unknown> };
const STYLE_SRC = {
  terrainUrl: 'pmtiles://https://example.test/map-packs/cell-52n157e.terrain.pmtiles',
  contoursUrl: 'https://example.test/map-packs/cell-52n157e.contours.geojson',
  terrainMaxZoom: 13,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: 'https://example.test/glyphs/{fontstack}/{range}.pbf',
  placesUrl: 'https://example.test/map-packs/cell-52n157e.places.geojson',
};

describe('слой мест в стиле карты', () => {
  it('реестр не пуст после боевой заливки: обзор, районы и все клетки', () => {
    expect(PLACES_BUILT).toContain(OVERVIEW_ID);
    for (const id of BUILT_PACK_REGIONS) expect(PLACES_BUILT, id).toContain(id);
    for (const id of BUILT_GRID_CELLS) expect(PLACES_BUILT, id).toContain(id);
    expect(new Set(PLACES_BUILT).size).toBe(PLACES_BUILT.length);
  });

  it('есть адрес — есть источник со СВОЕЙ атрибуцией и два слоя; нет — ничего', () => {
    const style = buildVedarStyle('dark', STYLE_SRC) as { sources: Record<string, { attribution?: string }>; layers: Layer[] };
    expect(style.sources['vedar-places']?.attribution).toBe(PLACES_ATTRIBUTION);
    expect(style.layers.map((l) => l.id)).toEqual(
      expect.arrayContaining(['vedar-places', 'vedar-place-labels']),
    );
    const bare = buildVedarStyle('dark', { ...STYLE_SRC, placesUrl: null }) as { sources: Record<string, unknown>; layers: Layer[] };
    expect(bare.sources['vedar-places']).toBeUndefined();
    expect(bare.layers.some((l) => l.id.startsWith('vedar-place'))).toBe(false);
  });

  it('id слоя не начинается с osm-: атрибуция OpenStreetMap к нашим данным не относится', () => {
    const style = buildVedarStyle('dark', STYLE_SRC) as { layers: Layer[] };
    for (const l of style.layers.filter((x) => x.source === 'vedar-places')) {
      expect(l.id.startsWith('osm-'), l.id).toBe(false);
    }
  });

  it('места — верхний слой: над посёлками OSM', () => {
    const src = { ...STYLE_SRC, osmUrls: { places: 'https://example.test/map-packs/cell-52n157e.osm-places.geojson' } };
    const ids = (buildVedarStyle('dark', src) as { layers: Layer[] }).layers.map((l) => l.id);
    expect(ids.indexOf('vedar-places')).toBeGreaterThan(ids.indexOf('osm-place-labels'));
    expect(ids.at(-1)).toBe('vedar-place-labels');
  });

  it('без глифов — только кружки, подписи не просятся (иначе MapLibre отвергает весь стиль)', () => {
    const style = buildVedarStyle('light', { ...STYLE_SRC, glyphsUrl: null }) as { layers: Layer[] };
    expect(style.layers.some((l) => l.id === 'vedar-places')).toBe(true);
    expect(style.layers.some((l) => l.id === 'vedar-place-labels')).toBe(false);
  });

  it('обе темы, с глифами и без, с адресом и без — валидны по спецификации', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const glyphsUrl of [STYLE_SRC.glyphsUrl, null]) {
        for (const placesUrl of [STYLE_SRC.placesUrl, null]) {
          const errors = validateStyleMin(buildVedarStyle(theme, { ...STYLE_SRC, glyphsUrl, placesUrl }) as never);
          expect(errors.map((e) => e.message), `${theme}/${glyphsUrl ? 'glyphs' : 'no-glyphs'}/${placesUrl ? 'places' : 'no-places'}`).toEqual([]);
        }
      }
    }
  });

  it('цвет — из данных профиля: hazard_types не пуст → тревога, иначе ориентир', () => {
    const style = buildVedarStyle('dark', STYLE_SRC) as { layers: Layer[] };
    const circle = style.layers.find((l) => l.id === 'vedar-places');
    expect(JSON.stringify(circle?.paint?.['circle-color'])).toContain('"hazard_types"');
    expect(JSON.stringify(circle?.paint?.['circle-color'])).not.toContain('location_type');
  });

  it('подкладка соседа (base) несёт слой с пространством имён региона; detail — нет', () => {
    const base = buildRegionOverlay('dark', STYLE_SRC, 'cell-53n158e', 'base');
    expect(Object.keys(base.sources)).toContain('vedar-places-cell-53n158e');
    expect(base.layers.map((l) => String(l.id))).toEqual(
      expect.arrayContaining(['vedar-places-cell-53n158e', 'vedar-place-labels-cell-53n158e']),
    );
    const detail = buildRegionOverlay('dark', STYLE_SRC, 'cell-53n158e', 'detail');
    expect(Object.keys(detail.sources)).not.toContain('vedar-places-cell-53n158e');
  });

  it('карта на маршруте и подкладки соседей передают адрес слоя из пакета', () => {
    const planning = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
    const vedarMap = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
    expect(planning).toMatch(/placesUrl: fieldBaseMap\.source\.placesUrl/);
    expect(vedarMap).toMatch(/placesUrl: pack\.source\.placesUrl/);
  });
});
