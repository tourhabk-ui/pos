/**
 * Свежесть сохранённой карты маршрута — сверкой с сегодняшним планом, а не
 * сроком годности (#2808, 30.10).
 *
 * Предложение просило `isPackStale(manifest, ttlDays)`. Срок годности здесь
 * нечестен: рельеф не меняется годами, а слой мест переиздаётся с новой
 * версией в адресе (PLACES_LAYER_VERSION) — скачанный до смены пакет по
 * пробе Cache Storage целый (старые адреса на месте), а без связи карта
 * запросит новый адрес, которого в кэше нет. Дата закачки об этом не скажет.
 *
 * Сторож держит поведение: план по текущему реестру против кэша →
 * «совпадает» / «отстаёт: чего не хватает» / «проверить нечем» (§4.0);
 * глифы в сверке не участвуют; без связи — не «свежая».
 */
import { describe, it, expect, vi } from 'vitest';
import { checkRouteMapFreshness, freshnessFromMissing, missingFromCache, missingKindsWords } from '@/lib/offline/map-freshness';
import { planRouteMapFiles, boundsOfBundle } from '@/lib/offline/route-map-save';
import type { PackFile } from '@/lib/offline/pack-files';
import type { RegionPack } from '@/lib/map/field-base-map';

const BASE = 'https://s3.example/bucket';
function pack(region: RegionPack['region'], bbox: RegionPack['bbox'], placesV: number): RegionPack {
  return {
    region,
    bbox,
    source: {
      state: 'ready',
      terrainUrl: `pmtiles://${BASE}/map-packs/${region}.terrain.pmtiles`,
      contoursUrl: `pmtiles://${BASE}/map-packs/${region}.contours.pmtiles`,
      terrainMaxZoom: 13,
      glyphsUrl: `${BASE}/map-packs/glyphs/{fontstack}/{range}.pbf`,
      glyphsFont: 'Noto Sans Regular',
      osmUrls: {},
      vectorUrl: `pmtiles://${BASE}/map-packs/${region}.vector.pmtiles`,
      placesUrl: `${BASE}/map-packs/${region}.places.geojson?v=${placesV}`,
      manifestUrl: `${BASE}/map-packs/${region}.manifest.json`,
      oceanUrl: null,
    },
  };
}

// Клетка под Авачинским перевалом.
const CELL = pack('cell-53n158e', { south: 53, west: 158, north: 54, east: 159 }, 45);
const BOUNDS = { route_bounds: { south: 53.2, west: 158.7, north: 53.3, east: 158.9 } };

function fetchBundle(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
}

/** Cache Storage, в котором лежат ровно эти адреса. */
function cachesWith(urls: readonly string[], opts: { throwOn?: string } = {}): CacheStorage {
  const set = new Set(urls);
  return {
    match: async (req: RequestInfo | URL) => {
      const url = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
      if (opts.throwOn && url.includes(opts.throwOn)) throw new Error('хранилище закрыто');
      return set.has(url) ? new Response('ok') : undefined;
    },
  } as unknown as CacheStorage;
}

describe('план файлов без замера веса', () => {
  it('рамка из ответа сервера, файлы по реестру; план не зовёт замер', async () => {
    expect(boundsOfBundle(BOUNDS)).toEqual({ south: 53.2, west: 158.7, north: 53.3, east: 158.9 });
    expect(boundsOfBundle({ bbox: { south: 'x' } })).toBeNull();
    const fetchFn = fetchBundle(BOUNDS);
    const r = await planRouteMapFiles('r1', [CELL], fetchFn);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.kind)).toEqual(expect.arrayContaining(['terrain', 'vector', 'contours', 'places', 'manifest', 'glyphs']));
    // Один поход — за рамкой; файлы по весу не меряются.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('сервер не отдал план — отказ словами, не пустой план', async () => {
    const r = await planRouteMapFiles('r1', [CELL], fetchBundle({ error: 'нет такого маршрута' }, false));
    expect(r).toEqual({ ok: false, error: expect.stringContaining('нет такого маршрута') });
  });
});

describe('сверка плана с кэшем', () => {
  const files: PackFile[] = [
    { url: `${BASE}/a.terrain`, kind: 'terrain', pack: 'c' },
    { url: `${BASE}/a.places?v=45`, kind: 'places', pack: 'c' },
    { url: `${BASE}/a.manifest`, kind: 'manifest', pack: 'c' },
  ];

  it('всё на месте — current', async () => {
    const probe = await missingFromCache(files, cachesWith(files.map((f) => f.url)));
    expect(freshnessFromMissing(probe)).toEqual({ state: 'current', checked: 3 });
  });

  it('слой мест переиздан (?v=44 в кэше, план ждёт ?v=45) — behind, и назван именно слой мест', async () => {
    const probe = await missingFromCache(files, cachesWith([`${BASE}/a.terrain`, `${BASE}/a.places?v=44`, `${BASE}/a.manifest`]));
    const r = freshnessFromMissing(probe);
    expect(r.state).toBe('behind');
    if (r.state !== 'behind') return;
    expect(r.missing.map((f) => f.kind)).toEqual(['places']);
    expect(r.note).toMatch(/отстаёт/);
    expect(r.note).toMatch(/слой мест/);
    expect(r.note).toMatch(/докачайте/);
  });

  it('ошибка похода в хранилище — не «файла нет»: адрес не считается ни туда, ни сюда', async () => {
    const probe = await missingFromCache(files, cachesWith([`${BASE}/a.places?v=45`, `${BASE}/a.manifest`], { throwOn: 'terrain' }));
    expect(probe).toEqual({ missing: [], checked: 2, unchecked: 1 });
    expect(freshnessFromMissing(probe).state).toBe('current');
  });

  it('нет Cache Storage или ни одного ответа — cannot_check, не current', async () => {
    expect(await missingFromCache(files, undefined)).toBeNull();
    expect(freshnessFromMissing(null)).toEqual({ state: 'cannot_check', reason: 'нет Cache Storage' });
    expect(freshnessFromMissing({ missing: [], checked: 0, unchecked: 3 }).state).toBe('cannot_check');
  });

  it('слова о недостающем — по одному на слой, в порядке плана', () => {
    expect(missingKindsWords([
      { url: 'a', kind: 'places', pack: 'c' }, { url: 'b', kind: 'terrain', pack: 'c' }, { url: 'c', kind: 'places', pack: 'd' },
    ])).toBe('слой мест, рельеф');
  });
});

describe('checkRouteMapFreshness — со связью по сегодняшнему плану', () => {
  const todayFiles = () => {
    // Что карта запросит сегодня для этой клетки (без глифов).
    const s = CELL.source;
    return [s.terrainUrl, s.vectorUrl!, s.contoursUrl, s.placesUrl!, s.manifestUrl!].map((u) => u.replace(/^pmtiles:\/\//, ''));
  };

  it('кэш совпадает с планом — current; глифы не проверяются', async () => {
    const cachesApi = cachesWith(todayFiles());
    const spy = vi.spyOn(cachesApi, 'match');
    const r = await checkRouteMapFreshness('r1', [CELL], { fetchFn: fetchBundle(BOUNDS), cachesApi, online: true });
    expect(r).toEqual({ state: 'current', checked: 5 });
    const asked = spy.mock.calls.map((c) => (c[0] as Request).url);
    expect(asked.some((u) => u.includes('glyphs'))).toBe(false);
  });

  it('в кэше карта, скачанная до смены версии слоя мест — behind', async () => {
    const old = todayFiles().map((u) => u.replace('?v=45', '?v=44'));
    const r = await checkRouteMapFreshness('r1', [CELL], { fetchFn: fetchBundle(BOUNDS), cachesApi: cachesWith(old), online: true });
    expect(r.state).toBe('behind');
    if (r.state === 'behind') expect(r.missing.map((f) => f.kind)).toEqual(['places']);
  });

  it('без связи — cannot_check с причиной: план считает сервер', async () => {
    const fetchFn = fetchBundle(BOUNDS);
    const r = await checkRouteMapFreshness('r1', [CELL], { fetchFn, cachesApi: cachesWith(todayFiles()), online: false });
    expect(r).toEqual({ state: 'cannot_check', reason: expect.stringContaining('нет связи') });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('сервер не отдал план — cannot_check с его словами', async () => {
    const r = await checkRouteMapFreshness('r1', [CELL], { fetchFn: fetchBundle({ error: 'база не ответила' }, false), cachesApi: cachesWith([]), online: true });
    expect(r).toEqual({ state: 'cannot_check', reason: expect.stringContaining('база не ответила') });
  });
});
