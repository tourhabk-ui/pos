/**
 * Эпоха кэша пакетов карты (24.09).
 *
 * Скрины владельца с /map: юг Камчатки прямоугольниками, суша обрывается на
 * 51°. На раннере тот же вид из тех же файлов ровный. Телефон держал копии,
 * закэшированные до 05.09 как `immutable` на год, — их браузер не
 * перепроверяет никогда, сколько заголовки в хранилище ни меняй. Лечится
 * новым адресом: `e=PACK_CACHE_EPOCH` в каждом адресе пакета.
 *
 * Сторож держит:
 *   1. эпоху несёт КАЖДЫЙ адрес каждого собранного пакета — один забытый род
 *      файла (глифы, паспорт, океан) остался бы старым навсегда;
 *   2. эпоха не старше смены политики кэша (05.09) — иначе она ничего не
 *      обходит;
 *   3. политика по-прежнему не отдаёт `immutable`: одна эпоха лечит только
 *      то, что закэшировано ДО политики, и держится ровно на ней;
 *   4. адрес с эпохой разбирается читателем PMTiles так же, как без неё.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACK_CACHE_EPOCH, withCacheEpoch, resolvePackSource, BUILT_PACK_REGIONS, BUILT_GRID_CELLS,
  OVERVIEW_BUILT, packKey, oceanKey,
} from '@/lib/map/pack-source';
import { packCacheControl } from '@/lib/map/pack-cache-policy';
import { OVERVIEW_ID, type PackRegionId } from '@/lib/geo/regions';

const B = 'https://s3.example.ru/bucket';
const MARK = `e=${PACK_CACHE_EPOCH}`;

function allUrls(id: PackRegionId): string[] {
  const r = resolvePackSource(id, BUILT_PACK_REGIONS, B);
  if (r.state !== 'ready') return [];
  return [
    r.terrainUrl, r.contoursUrl, r.glyphsUrl, r.vectorUrl, r.placesUrl, r.manifestUrl, r.oceanUrl,
    ...Object.values(r.osmUrls),
  ].filter((u): u is string => typeof u === 'string');
}

describe('эпоха кэша в каждом адресе пакета', () => {
  const ids: PackRegionId[] = [
    ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS, ...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []),
  ];

  it('собранные пакеты есть — иначе проверять было бы нечего', () => {
    expect(ids.length).toBeGreaterThan(10);
  });

  it('каждый адрес каждого собранного пакета несёт эпоху ровно один раз', () => {
    let checked = 0;
    for (const id of ids) {
      for (const u of allUrls(id)) {
        expect(u, `${id}: ${u}`).toContain(MARK);
        expect(u.split(MARK).length - 1, `${id}: эпоха дважды`).toBe(1);
        checked++;
      }
    }
    // Ноль проверенных адресов при непустом списке пакетов — отказ, а не успех.
    expect(checked).toBeGreaterThan(ids.length);
  });

  it('обзор: рельеф и океан — те самые файлы, что застряли у владельца', () => {
    const r = resolvePackSource(OVERVIEW_ID, BUILT_PACK_REGIONS, B);
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    expect(r.terrainUrl).toBe(`pmtiles://${B}/${packKey(OVERVIEW_ID, 'terrain')}?${MARK}`);
    if (r.oceanUrl) expect(r.oceanUrl).toBe(`${B}/${oceanKey(OVERVIEW_ID)}?${MARK}`);
  });

  it('адрес с параметрами получает эпоху через &, а не второй ?', () => {
    expect(withCacheEpoch('https://x/a.geojson?v=18')).toBe(`https://x/a.geojson?v=18&${MARK}`);
    expect(withCacheEpoch('https://x/a.geojson')).toBe(`https://x/a.geojson?${MARK}`);
  });
});

describe('эпоха держится на политике кэша', () => {
  it('эпоха — дата не раньше смены политики (05.09)', () => {
    expect(PACK_CACHE_EPOCH).toMatch(/^\d{8}$/);
    expect(Number(PACK_CACHE_EPOCH)).toBeGreaterThanOrEqual(20260905);
  });

  it('политика не отдаёт immutable ни одному роду файла пакета', () => {
    for (const key of [
      'map-packs/x.terrain.pmtiles', 'map-packs/x.vector.pmtiles', 'map-packs/x.contours.geojson',
      'map-packs/x.ocean.geojson', 'map-packs/x.places.geojson', 'map-packs/x.manifest.json',
      'map-packs/glyphs/Noto Sans Regular/0-255.pbf',
    ]) {
      const cc = packCacheControl(key);
      expect(cc, key).not.toMatch(/immutable|max-age=[1-9]/);
    }
  });
});

describe('читатель PMTiles разбирает адрес с эпохой', () => {
  it('архив восстанавливается целиком вместе с эпохой, z/x/y — отдельно', () => {
    // Тот же разбор, что у pmtiles Protocol.tile (v4): жадное (.+) до /z/x/y.
    const re = /pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)/;
    const archive = withCacheEpoch(`${B}/${packKey(OVERVIEW_ID, 'terrain')}`);
    const m = `pmtiles://${archive}/5/27/10`.match(re);
    expect(m?.[1]).toBe(archive);
    expect(m?.slice(2)).toEqual(['5', '27', '10']);
  });

  it('снимки на раннере убирают эпоху из ключа тайла', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/map-tiles/snapshot-packs.ts'), 'utf-8');
    expect(src).toMatch(/const shortKey = \(url\) => url\.replace\([^\n]*\.replace\(\/\\\\\?\[\^\/\]\*\/, ''\)/);
  });
});
