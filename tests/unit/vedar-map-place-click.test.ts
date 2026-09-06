/**
 * Клик по месту платформы на VedarMap (владелец 06.09, «замкнуть /map на
 * VedarMap»): своя карта browse-режима отдаёт то, что уже несёт слой
 * vedar-places (id/имя/тип/координаты точки), а не голую координату тапа.
 * Сторож держит:
 *   - проверка идёт queryRenderedFeatures ПЕРЕД generic onMapClick;
 *   - фильтр по слою — префикс vedar-places (не vedar-place-labels);
 *   - /map: пакеты и обзорный источник строятся так же, как на полевом
 *     экране (builtRegionPacks/resolvePackSource), Leaflet — запасной путь;
 *   - клик по месту открывает PlaceMapSheet из данных самого тапа, не из
 *     живого списка allRoutes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MAP = read('components/shared/VedarMap.tsx');
const PAGE = read('app/map/page.tsx');
const CLIENT = read('app/map/_MapPageClient.tsx');

describe('VedarMap — onPlaceClick', () => {
  it('queryRenderedFeatures фильтрует по префиксу vedar-places, не по vedar-place-labels', () => {
    expect(MAP).toMatch(/f\.layer\.id\.startsWith\('vedar-places'\)/);
  });

  it('находка места идёт раньше generic onMapClick и несёт id/координаты/имя/тип', () => {
    const clickAt = MAP.indexOf("map.on('click', (e) => {");
    const placeCallAt = MAP.indexOf('onPlaceClickRef.current({', clickAt);
    const mapClickCallAt = MAP.indexOf('onMapClickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });', clickAt);
    expect(clickAt).toBeGreaterThan(-1);
    expect(placeCallAt).toBeGreaterThan(clickAt);
    expect(mapClickCallAt).toBeGreaterThan(placeCallAt);
    const block = MAP.slice(placeCallAt, mapClickCallAt);
    expect(block).toContain('id: placeId');
    expect(block).toContain('lng: coords[0]');
    expect(block).toContain('lat: coords[1]');
  });

  it('экспортирует VedarMapPlaceHit — тип для вызывающего', () => {
    expect(MAP).toContain('export interface VedarMapPlaceHit');
  });
});

describe('/map — та же подложка, что на полевом экране', () => {
  it('сервер отдаёт mapPackBaseUrl клиенту', () => {
    expect(PAGE).toContain('MAP_PACK_BASE_URL_ENV');
    expect(PAGE).toMatch(/<MapPageClient mapPackBaseUrl=\{mapPackBaseUrl\}/);
  });

  it('клиент строит пакеты и обзорный источник теми же функциями, что trail', () => {
    expect(CLIENT).toContain("import { builtRegionPacks } from '@/lib/map/field-base-map'");
    expect(CLIENT).toMatch(/builtRegionPacks\(mapPackBaseUrl\)/);
    expect(CLIENT).toMatch(/resolvePackSource\(\s*OVERVIEW_ID, BUILT_PACK_REGIONS, mapPackBaseUrl/);
  });

  it('своя карта включается по готовности обзора, Leaflet — запасной путь', () => {
    expect(CLIENT).toMatch(/vedarReady = overviewSource\.state === 'ready'/);
    expect(CLIENT).toMatch(/\{vedarReady \? \(\s*<VedarMap/);
    expect(CLIENT).toContain('<LeafletMap');
  });

  it('клик по месту открывает карточку из самого тапа, не из allRoutes', () => {
    expect(CLIENT).toMatch(/onPlaceClick=\{setVedarPlaceHit\}/);
    expect(CLIENT).toMatch(/\{vedarPlaceHit && \(/);
    expect(CLIENT).toMatch(/id: vedarPlaceHit\.id/);
    expect(CLIENT).toMatch(/title: vedarPlaceHit\.name \?\? 'Место'/);
  });
});
