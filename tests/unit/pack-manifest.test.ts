/**
 * Паспорт пакета карты (05.09): «данных о тропах здесь нет» — словами.
 *
 * После 112 клеток у корякских OSM-слои пусты, и карта об этом молчала так
 * же, как при сбое загрузки. Сторож держит: три исхода суждения о покрытии
 * (не знаю / всё есть / чего именно нет), разбор паспорта без исключений,
 * один ключ на заливку-проверку-карту, паспорт пишется заливкой пакета и
 * снимается переписью с залитых, карта на маршруте показывает его словами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPackManifest, parsePackManifest, coverageNotice, countGeoJsonFeatures, PACK_MANIFEST_V,
} from '@/lib/map/pack-manifest';
import {
  manifestKey, MANIFEST_BUILT, OSM_LAYERS, resolvePackSource, BUILT_PACK_REGIONS, BUILT_GRID_CELLS,
  OVERVIEW_BUILT, OSM_BUILT_REGIONS, type OsmLayer,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, type PackRegionId } from '@/lib/geo/regions';
import { packKeysToVerify } from '@/scripts/map-tiles/verify-packs';
import { manifestTargets } from '@/scripts/map-tiles/build-manifests';

const ROOT = process.cwd();
const UPLOAD = readFileSync(join(ROOT, 'scripts/map-tiles/upload-pack.ts'), 'utf-8');
const BACKFILL = readFileSync(join(ROOT, 'scripts/map-tiles/build-manifests.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-manifest.yml'), 'utf-8');
const PLANNING = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const MARKER = JSON.parse(readFileSync(join(ROOT, '.github/triggers/map-pack-manifest.json'), 'utf-8')) as { upload?: unknown };
const B = 'https://s3.example.ru/b';
const ALL: PackRegionId[] = [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS];

function full(over: Partial<Record<OsmLayer, number>>): Partial<Record<OsmLayer, number>> {
  const osm: Partial<Record<OsmLayer, number>> = {};
  for (const l of OSM_LAYERS) osm[l] = 5;
  return { ...osm, ...over };
}

describe('суждение о покрытии — три исхода', () => {
  it('нет паспорта — молчим: «не знаю» не равно «пусто»', () => {
    expect(coverageNotice(null)).toBeNull();
  });

  it('тропы есть — тишина: говорить нечего', () => {
    expect(coverageNotice(buildPackManifest('cell-52n157e', full({ paths: 120, roads: 30 })))).toBeNull();
    // Пустой ледник или болото — не новость и не повод для подписи.
    expect(coverageNotice(buildPackManifest('cell-52n157e', full({ glacier: 0, wetland: 0 })))).toBeNull();
  });

  it('троп нет — говорим, чего нет, и что это не сбой', () => {
    const noPaths = coverageNotice(buildPackManifest('c', full({ paths: 0, roads: 4 })));
    expect(noPaths).toMatch(/Троп в OSM для этого пакета нет, только дороги/);
    const noBoth = coverageNotice(buildPackManifest('c', full({ paths: 0, roads: 0 })));
    expect(noBoth).toMatch(/Троп и дорог в OSM для этого пакета нет/);
    expect(noBoth).toMatch(/не сбой загрузки/);
    const osm: Partial<Record<OsmLayer, number>> = {};
    for (const l of OSM_LAYERS) osm[l] = 0;
    const empty = coverageNotice(buildPackManifest('c', osm));
    expect(empty).toMatch(/В OSM для этого пакета пусто/);
    expect(empty).toMatch(/места платформы/);
  });

  it('тропы/дороги не считались — суждения нет', () => {
    expect(coverageNotice(buildPackManifest('c', { water: 0 }))).toBeNull();
  });
});

describe('паспорт: разбор и счёт', () => {
  it('разбор без исключений; чужие поля и отрицательные числа отбрасываются', () => {
    expect(parsePackManifest(null)).toBeNull();
    expect(parsePackManifest('x')).toBeNull();
    expect(parsePackManifest({ v: 1, region: 'c' })).toBeNull();
    const m = parsePackManifest({ v: PACK_MANIFEST_V, region: 'c', built_at: 't', osm: { paths: 3, roads: -1, bogus: 9, water: 'no' } });
    expect(m).toEqual({ v: PACK_MANIFEST_V, region: 'c', built_at: 't', osm: { paths: 3 } });
  });

  it('счёт объектов: испорченный файл — null, не ноль', () => {
    expect(countGeoJsonFeatures('{"type":"FeatureCollection","features":[]}')).toBe(0);
    expect(countGeoJsonFeatures('{"type":"FeatureCollection","features":[{},{}]}')).toBe(2);
    expect(countGeoJsonFeatures('{"type":"Feature"}')).toBeNull();
    expect(countGeoJsonFeatures('{"type":"FeatureCollection","features":[')).toBeNull();
  });

  it('паспорт в build держит версию и все посчитанные слои', () => {
    const m = buildPackManifest('cell-52n157e', { paths: 1 }, '2026-09-05T00:00:00Z');
    expect(m).toEqual({ v: PACK_MANIFEST_V, region: 'cell-52n157e', built_at: '2026-09-05T00:00:00Z', osm: { paths: 1 } });
  });
});

describe('ключ и реестр', () => {
  it('одна формула ключа', () => {
    expect(manifestKey('cell-52n157e')).toBe('map-packs/cell-52n157e.manifest.json');
  });

  it('обещание MANIFEST_BUILT — только о пакетах, которые существуют; адрес ровно у них', () => {
    for (const id of MANIFEST_BUILT) expect(ALL, id).toContain(id);
    for (const id of ALL) {
      const r = resolvePackSource(id, BUILT_PACK_REGIONS, B);
      if (r.state !== 'ready') continue;
      expect(r.manifestUrl !== null, id).toBe(MANIFEST_BUILT.includes(id));
      if (r.manifestUrl) expect(r.manifestUrl).toBe(`${B}/${manifestKey(id)}`);
    }
  });

  it('проверка хранилища знает паспорт по тому же реестру', () => {
    const keys = packKeysToVerify().map((k) => k.key);
    for (const id of MANIFEST_BUILT) expect(keys).toContain(manifestKey(id));
  });

  it('перепись целит в пакеты с OSM: районы из OSM_BUILT_REGIONS и все клетки, без обзора', () => {
    const t = manifestTargets();
    expect(t).not.toContain(OVERVIEW_ID);
    for (const r of BUILT_PACK_REGIONS) expect(t.includes(r)).toBe(OSM_BUILT_REGIONS.includes(r));
    for (const c of BUILT_GRID_CELLS) expect(t).toContain(c);
  });
});

describe('кто пишет и кто читает', () => {
  it('заливка пакета пишет паспорт с тех же файлов, что залила', () => {
    expect(UPLOAD).toMatch(/countGeoJsonFeatures\(body\.toString\('utf-8'\)\)/);
    expect(UPLOAD).toMatch(/uploadToS3\(manifestKey\(region as PackRegionId\)/);
  });

  it('перепись: сначала все чтения, потом все записи; workflow зовёт её', () => {
    expect(BACKFILL.indexOf('Фаза 1')).toBeGreaterThan(0);
    expect(BACKFILL.indexOf('Фаза 2')).toBeGreaterThan(BACKFILL.indexOf('Фаза 1'));
    expect(BACKFILL).toMatch(/Ничего не записано: паспорта либо целиком, либо никак/);
    expect(WF).toContain('scripts/map-tiles/build-manifests.ts');
    expect(WF).toContain('.github/triggers/map-pack-manifest.json');
    expect(typeof MARKER.upload).toBe('boolean');
  });

  it('карта на маршруте читает паспорт и показывает суждение словами, приглушённо', () => {
    expect(PLANNING).toMatch(/fieldBaseMap\.source\.manifestUrl/);
    expect(PLANNING).toMatch(/coverageNotice\(parsePackManifest\(body\)\)/);
    const i = PLANNING.indexOf('{coverageNote}');
    expect(i).toBeGreaterThan(0);
    expect(PLANNING.slice(i - 300, i)).toContain("var(--text-muted)");
  });
});
