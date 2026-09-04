// @vitest-environment node
/**
 * Отказ карты называет ФАЙЛ, а проверка хранилища — три исхода (02.09).
 *
 * Скрин владельца из поля: «Своя карта не отрисовалась: Expected ',' or ']'
 * after array element in JSON at position 387966 (line 1 column 387967)».
 * Позиция ошибки совпадает с концом текста — так JSON.parse говорит про
 * ОБОРВАННОЕ тело, а не про испорченную середину. Но какой из восьмидесяти
 * файлов пакета оборвался, из сообщения не следовало никак, и «карта не
 * отрисовалась» было неправдой: карта рисовала, не пришёл один слой.
 *
 * Сторож держит обе половины лечения:
 *   - имя источника переводится в имя файла ИЗ САМОГО СТИЛЯ (разбор строки
 *     `osm-paths-south-kamchatka` на дефисы неоднозначен);
 *   - проверка хранилища различает «цел», «оборван», «не читается»,
 *     «не отдан» и «не смог проверить» — последний не равен первому (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceUrlIndex, buildVedarStyle, buildRegionOverlay } from '@/lib/map/vedar-style';
import { mapErrorText } from '@/components/shared/VedarMap';
import { packKeysToVerify, jsonFailure, verifyPacks, packUrl } from '@/scripts/map-tiles/verify-packs';
import {
  BUILT_PACK_REGIONS, OSM_BUILT_REGIONS, OSM_LAYERS, BUILT_GRID_CELLS, OVERVIEW_BUILT,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';

const SOURCES = {
  terrainUrl: 'pmtiles://https://s3.example.ru/b/map-packs/avacha-group.terrain.pmtiles',
  contoursUrl: 'https://s3.example.ru/b/map-packs/avacha-group.contours.geojson',
  terrainMaxZoom: 13,
  attribution: '© Copernicus DEM (ESA)',
  glyphsUrl: 'https://s3.example.ru/b/map-packs/glyphs/{fontstack}/{range}.pbf',
  glyphsFont: 'Noto Sans Regular',
  osmUrls: {
    paths: 'https://s3.example.ru/b/map-packs/avacha-group.osm.paths.geojson',
    peaks: 'https://s3.example.ru/b/map-packs/avacha-group.osm.peaks.geojson',
  },
} as const;

describe('источник -> файл: имя берётся из стиля, а не разбором строки', () => {
  it('основной стиль отдаёт адреса рельефа, горизонталей и слоёв OSM', () => {
    const style = buildVedarStyle('dark', { ...SOURCES });
    const index = sourceUrlIndex(style.sources as Record<string, unknown>);
    expect(index.contours).toBe(SOURCES.contoursUrl);
    expect(index.terrain).toBe(SOURCES.terrainUrl);
    expect(index['osm-paths']).toBe(SOURCES.osmUrls.paths);
  });

  it('встроенный GeoJSON маршрута файла не имеет и в индекс не попадает', () => {
    const style = buildVedarStyle('dark', { ...SOURCES });
    const index = sourceUrlIndex(style.sources as Record<string, unknown>);
    expect(index.route).toBeUndefined();
  });

  it('соседний район: имя района с дефисами разбором не восстановить, из стиля — можно', () => {
    const overlay = buildRegionOverlay('dark', { ...SOURCES }, 'south-kamchatka', 'detail');
    const index = sourceUrlIndex(overlay.sources);
    expect(index['contours-south-kamchatka']).toBe(SOURCES.contoursUrl);
    expect(index['osm-paths-south-kamchatka']).toBe(SOURCES.osmUrls.paths);
  });
});

describe('текст отказа карты: три разные беды — три разные фразы', () => {
  it('карта поднялась, упал источник — это СЛОЙ, а не карта', () => {
    const out = mapErrorText({
      message: "Expected ',' or ']' after array element in JSON at position 387966",
      sourceId: 'osm-paths-south-kamchatka',
      file: 'https://s3.example.ru/b/map-packs/south-kamchatka.osm.paths.geojson',
      mapLoaded: true,
    });
    expect(out).toBe(
      'Слой карты не пришёл — south-kamchatka.osm.paths.geojson: '
      + "Expected ',' or ']' after array element in JSON at position 387966",
    );
  });

  it('карта не поднялась — прежние слова, но с именем файла', () => {
    const out = mapErrorText({
      message: 'Failed to fetch',
      sourceId: 'contours',
      file: 'https://s3.example.ru/b/map-packs/avacha-group.contours.geojson',
      mapLoaded: false,
    });
    expect(out).toBe('Своя карта не отрисовалась — avacha-group.contours.geojson: Failed to fetch');
  });

  it('источник неизвестен — не выдумываем имя, говорим как раньше', () => {
    expect(mapErrorText({ message: 'boom', mapLoaded: false }))
      .toBe('Своя карта не отрисовалась: boom');
  });

  it('адреса файла нет, но имя источника есть — оно и называется', () => {
    expect(mapErrorText({ message: 'boom', sourceId: 'osm-roads', mapLoaded: true }))
      .toBe('Слой карты не пришёл — osm-roads: boom');
  });

  it('ошибка без текста не превращается в пустую строку', () => {
    expect(mapErrorText({ mapLoaded: false })).toBe('Своя карта не отрисовалась: неизвестная ошибка');
  });

  it('повтор назван словами: «качаем заново» — это не «не придёт»', () => {
    const out = mapErrorText({
      message: 'Unexpected end of JSON input',
      sourceId: 'osm-wood',
      file: 'https://s3.example.ru/b/map-packs/kronotsky.osm.wood.geojson',
      mapLoaded: true,
      retrying: true,
    });
    expect(out).toMatch(/ — качаем заново$/);
  });
});

describe('оборванный слой заказывается заново — ровно один раз', () => {
  /**
   * Перепись хранилища с раннера 02.09: все 90 файлов целы (118 МБ скачаны и
   * разобраны). Значит GeoJSON рвался по дороге на телефон, а своего повтора
   * у geojson-источника нет: один обрыв — и слой мёртв до пересоздания карты.
   */
  const SRC = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

  it('повтор заказывается setData по тому же адресу', () => {
    expect(SRC).toMatch(/src\.setData\(file\)/);
  });

  it('повтор ровно один на источник — бесконечные попытки на глухом канале жгут батарею', () => {
    expect(SRC).toMatch(/const retriedSources = new Set<string>\(\)/);
    expect(SRC).toMatch(/!retriedSources\.has\(sourceId\)/);
    expect(SRC).toMatch(/retriedSources\.add\(sourceId\)/);
  });

  it('удавшийся повтор снимает сообщение: жалоба на живой слой хуже молчания', () => {
    expect(SRC).toMatch(/map\.on\('sourcedata'/);
    expect(SRC).toMatch(/awaitingRetry && ev\.sourceId === awaitingRetry && ev\.isSourceLoaded/);
  });

  it('отказ самого повтора не глушится', () => {
    expect(SRC).toMatch(/повтор источника не удался/);
  });
});

describe('VedarMap: индекс имён строится из стиля и пополняется соседями', () => {
  const SRC = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

  it('индекс собирается из того же объекта стиля, которым создаётся карта', () => {
    expect(SRC).toMatch(/fileBySourceRef\.current = sourceUrlIndex\(style\.sources/);
  });

  it('подложенный сосед попадает в индекс вместе со своими источниками', () => {
    expect(SRC).toMatch(/Object\.assign\(fileBySourceRef\.current, sourceUrlIndex\(overlay\.sources\)\)/);
  });

  it('обработчик ошибки читает sourceId у события, а не гадает', () => {
    expect(SRC).toMatch(/sourceId\?: string \} \| undefined\)\?\.sourceId/);
    expect(SRC).toMatch(/setMapError\(mapErrorText\(/);
  });
});

describe('проверка хранилища: список файлов — из реестров, не свой', () => {
  it('проверяются рельеф и горизонтали каждого собранного района', () => {
    const keys = packKeysToVerify().map(k => k.key);
    for (const region of BUILT_PACK_REGIONS) {
      expect(keys).toContain(`map-packs/${region}.terrain.pmtiles`);
      expect(keys).toContain(`map-packs/${region}.contours.geojson`);
    }
  });

  it('семь слоёв OSM — только у районов, где они объявлены собранными', () => {
    const keys = packKeysToVerify().map(k => k.key);
    for (const region of OSM_BUILT_REGIONS) {
      for (const layer of OSM_LAYERS) {
        expect(keys).toContain(`map-packs/${region}.osm.${layer}.geojson`);
      }
    }
    const notBuilt = BUILT_PACK_REGIONS.filter(r => !OSM_BUILT_REGIONS.includes(r));
    for (const region of notBuilt) {
      expect(keys).not.toContain(`map-packs/${region}.osm.paths.geojson`);
    }
  });

  it('архив читается Range-запросом, GeoJSON — целиком (иначе обрыв в конце не виден)', () => {
    const kinds = new Map(packKeysToVerify().map(k => [k.key, k.kind]));
    expect(kinds.get(`map-packs/${BUILT_PACK_REGIONS[0]}.terrain.pmtiles`)).toBe('archive');
    expect(kinds.get(`map-packs/${BUILT_PACK_REGIONS[0]}.contours.geojson`)).toBe('json');
  });

  it('04.09: клетки сетки «вся Камчатка» проверяются тем же списком — рельеф, горизонтали, все слои OSM, вектор', () => {
    // Скрин владельца из поля: cell-53n158e.terrain.pmtiles не пришёл. До этой
    // правки packKeysToVerify() клеток не видел вовсе — прогон был бы зелёным
    // и про эту клетку ничего бы не сказал.
    expect(BUILT_GRID_CELLS.length).toBeGreaterThan(0);
    const keys = packKeysToVerify().map(k => k.key);
    const kinds = new Map(packKeysToVerify().map(k => [k.key, k.kind]));
    for (const cell of BUILT_GRID_CELLS) {
      expect(keys).toContain(`map-packs/${cell}.terrain.pmtiles`);
      expect(keys).toContain(`map-packs/${cell}.contours.geojson`);
      expect(keys).toContain(`map-packs/${cell}.vector.pmtiles`);
      for (const layer of OSM_LAYERS) expect(keys).toContain(`map-packs/${cell}.osm.${layer}.geojson`);
    }
    expect(kinds.get(`map-packs/${BUILT_GRID_CELLS[0]}.terrain.pmtiles`)).toBe('archive');
    expect(kinds.get(`map-packs/${BUILT_GRID_CELLS[0]}.vector.pmtiles`)).toBe('archive');
    expect(kinds.get(`map-packs/${BUILT_GRID_CELLS[0]}.contours.geojson`)).toBe('json');
  });

  it('04.09: обзорный ярус края — только рельеф и горизонтали, если собран', () => {
    const keys = packKeysToVerify().map(k => k.key);
    if (OVERVIEW_BUILT) {
      expect(keys).toContain(`map-packs/${OVERVIEW_ID}.terrain.pmtiles`);
      expect(keys).toContain(`map-packs/${OVERVIEW_ID}.contours.geojson`);
    }
    expect(keys).not.toContain(`map-packs/${OVERVIEW_ID}.vector.pmtiles`);
    expect(keys).not.toContain(`map-packs/${OVERVIEW_ID}.osm.paths.geojson`);
  });
});

describe('packUrl: адрес собирает платформа, а не склейка строк', () => {
  it('лишний слэш базы не удваивается', () => {
    expect(packUrl('https://s3.example.ru/b/', 'map-packs/a.geojson'))
      .toBe('https://s3.example.ru/b/map-packs/a.geojson');
    expect(packUrl('https://s3.example.ru/b', 'map-packs/a.geojson'))
      .toBe('https://s3.example.ru/b/map-packs/a.geojson');
  });

  it('не-HTTP адрес отвергается словами, а не молча', () => {
    expect(() => packUrl('file:///etc', 'map-packs/a.geojson')).toThrow(/http/);
  });
});

describe('jsonFailure: обрыв и порча — разные диагнозы', () => {
  it('целый JSON — не беда', () => {
    expect(jsonFailure('{"type":"FeatureCollection","features":[]}')).toBeNull();
  });

  it('оборванный текст назван обрывом: позиция совпала с концом', () => {
    const bad = jsonFailure('{"features":[1,2');
    expect(bad?.detail).toMatch(/КОНЕЦ текста: тело оборвано/);
  });

  it('порча в середине показывает кусок текста вокруг места', () => {
    const bad = jsonFailure('{"features":[1,2 3]}');
    expect(bad?.detail).toMatch(/рядом: /);
    expect(bad?.detail).not.toMatch(/КОНЕЦ текста/);
  });
});

describe('verifyPacks: у каждого файла ровно один вердикт', () => {
  const ONE = 'map-packs/avacha-group.contours.geojson';

  function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return (async (url: string) => handler(String(url))) as unknown as typeof fetch;
  }

  it('целый файл — ok, с размером', async () => {
    const body = '{"type":"FeatureCollection","features":[]}';
    const out = await verifyPacks('https://s3.example.ru/b/', fakeFetch(() =>
      new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })));
    const one = out.find(c => c.key === ONE)!;
    expect(one.verdict).toBe('ok');
    expect(one.bytes).toBe(body.length);
  });

  it('тело короче обещанного — truncated, с недостачей в байтах', async () => {
    const body = '{"type":"FeatureCollection","features":[]}';
    const out = await verifyPacks('https://s3.example.ru/b', fakeFetch(() =>
      new Response(body, { status: 200, headers: { 'content-length': String(body.length + 100) } })));
    const one = out.find(c => c.key === ONE)!;
    expect(one.verdict).toBe('truncated');
    expect(one.detail).toMatch(/100 байт не доехало/);
  });

  it('тело целое, но не разбирается — bad_json', async () => {
    const body = '{"features":[1,2';
    const out = await verifyPacks('https://s3.example.ru/b', fakeFetch(() =>
      new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })));
    expect(out.find(c => c.key === ONE)!.verdict).toBe('bad_json');
  });

  it('403 бакета — http, а не «файл испорчен»', async () => {
    const out = await verifyPacks('https://s3.example.ru/b', fakeFetch(() =>
      new Response('', { status: 403 })));
    expect(out.find(c => c.key === ONE)!.verdict).toBe('http');
  });

  it('запрос не состоялся — «не смог проверить», а не «цел»', async () => {
    const out = await verifyPacks('https://s3.example.ru/b', fakeFetch(() => {
      throw new TypeError('fetch failed');
    }));
    const one = out.find(c => c.key === ONE)!;
    expect(one.verdict).toBe('unreachable');
    expect(one.detail).toMatch(/TypeError: fetch failed/);
  });

  it('архив без заголовка PMTiles — беда файла, а не сети', async () => {
    const out = await verifyPacks('https://s3.example.ru/b', fakeFetch(() =>
      new Response('<?xml version="1.0"?><Error/>', { status: 206 })));
    const arch = out.find(c => c.key.endsWith('.terrain.pmtiles'))!;
    expect(arch.verdict).toBe('bad_json');
    expect(arch.detail).toMatch(/заголовок не PMTiles/);
  });
});
