/**
 * Cache-Control у файлов пакетов карты (05.09, снимки 8-11).
 *
 * Сторож держит три вещи: политика — архивам по Range no-store, остальному
 * no-cache; ВСЕ заливки под map-packs/ её передают (одна забытая — и файл
 * снова уедет с «год, immutable»); фото и видео политику не меняют — у них
 * новый файл — новый ключ, и год там честен.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packCacheControl, packContentType } from '@/lib/map/pack-cache-policy';
import { stampPlan } from '@/scripts/map-tiles/stamp-cache-control';
import { packKeysToVerify } from '@/scripts/map-tiles/verify-packs';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('политика Cache-Control пакетов карты', () => {
  it('архивам по Range — no-store, целым файлам — no-cache', () => {
    expect(packCacheControl('map-packs/cell-54n158e.terrain.pmtiles')).toBe('no-store');
    expect(packCacheControl('map-packs/cell-54n158e.vector.pmtiles')).toBe('no-store');
    expect(packCacheControl('map-packs/cell-54n158e.contours.geojson')).toBe('no-cache');
    expect(packCacheControl('map-packs/cell-54n158e.manifest.json')).toBe('no-cache');
    expect(packCacheControl('map-packs/glyphs/Noto Sans Regular/0-255.pbf')).toBe('no-cache');
  });

  it('MIME по ключу — тот же, что у заливки; чужой род — отказ словами', () => {
    expect(packContentType('a.terrain.pmtiles')).toBe('application/octet-stream');
    expect(packContentType('a.osm.paths.geojson')).toBe('application/geo+json');
    expect(packContentType('a.manifest.json')).toBe('application/json');
    expect(packContentType('glyphs/x/0-255.pbf')).toBe('application/x-protobuf');
    expect(() => packContentType('a.png')).toThrow(/неизвестный род/);
  });

  it('план штамповки — весь реестр проверки хранилища, и каждый ключ штампуется по политике', () => {
    const all = stampPlan(null);
    expect(all.length).toBe(packKeysToVerify().length);
    expect(all.length).toBeGreaterThan(2000);
    for (const p of all) {
      expect(p.cacheControl).toBe(packCacheControl(p.key));
      expect(p.contentType).toBe(packContentType(p.key));
    }
    const archives = stampPlan('pmtiles');
    expect(archives.every((p) => p.key.endsWith('.pmtiles') && p.cacheControl === 'no-store')).toBe(true);
    expect(archives.length).toBeGreaterThan(200);
  });

  it('все заливки под map-packs/ передают packCacheControl; умолчание uploadToS3 (фото) не тронуто', () => {
    const uploaders = [
      'scripts/map-tiles/upload-pack.ts', 'scripts/map-tiles/upload-ocean.ts', 'scripts/map-tiles/upload-glyphs.ts',
      'scripts/map-tiles/build-places.ts', 'scripts/map-tiles/build-manifests.ts',
    ];
    for (const f of uploaders) {
      const src = read(f);
      const calls = src.match(/uploadToS3\(/g)?.length ?? 0;
      const withPolicy = src.match(/packCacheControl\(/g)?.length ?? 0;
      expect(calls, f).toBeGreaterThan(0);
      expect(withPolicy, `${f}: вызовов uploadToS3 ${calls}, с политикой ${withPolicy}`).toBe(calls);
    }
    expect(read('lib/storage/s3.ts')).toMatch(/cacheControl: string = 'public, max-age=31536000, immutable'/);
    expect(read('lib/storage/s3.ts')).toMatch(/MetadataDirective: 'REPLACE'/);
  });

  it('workflow штамповки зовёт скрипт по файлу-триггеру', () => {
    const wf = read('.github/workflows/map-pack-stamp.yml');
    expect(wf).toContain('scripts/map-tiles/stamp-cache-control.ts');
    expect(wf).toContain('.github/triggers/map-pack-stamp.json');
    const marker = JSON.parse(read('.github/triggers/map-pack-stamp.json')) as { run: unknown; dry_run: unknown };
    expect(typeof marker.run).toBe('number');
    expect(typeof marker.dry_run).toBe('boolean');
  });
});
