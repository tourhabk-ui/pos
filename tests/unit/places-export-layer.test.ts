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

  it('умолчание маркера — сухой прогон', () => {
    expect(MARKER.upload).toBe(false);
    expect(typeof MARKER.expect_v).toBe('number');
  });
});
