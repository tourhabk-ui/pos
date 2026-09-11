/**
 * Чистая логика сверки вулканов с Global Volcanism Program — без сети/БД.
 *
 * Ключевая проверка этого файла: кандидаты подбираются по РАССТОЯНИЮ, а не
 * по имени (в отличие от osm-crosscheck.test.ts) — `places.name` по-русски,
 * `VolcanoName` ГВП по-английски, сравнивать их через pg_trgm бесполезно.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGvpFeatureUrl, parseGvpFeatures, buildVolcanoCrosscheckItems,
  type GvpVolcano, type PlaceInput,
} from '@/lib/geo/gvp-crosscheck';

describe('buildGvpFeatureUrl', () => {
  it('содержит слой, propertyName и bbox в порядке lng,lat,lng,lat', () => {
    const url = buildGvpFeatureUrl({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(url).toContain('webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs');
    expect(url).toContain('typeName=GVP-VOTW%3AE3WebApp_HoloceneVolcanoes');
    expect(url).toContain('LatitudeDecimal');
    expect(url).toContain('LongitudeDecimal');
    // Порядок подтверждён пробой с раннера (11.09) — не взят из спецификации.
    expect(url).toMatch(/bbox=155%2C50%2C167%2C64%2CEPSG%3A4326/);
  });

  it('не просит Remarks/VPImage — они раздувают ответ и не нужны для сверки координат', () => {
    const url = buildGvpFeatureUrl({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(url).not.toContain('Remarks');
    expect(url).not.toContain('VPImage');
  });
});

describe('parseGvpFeatures', () => {
  const feature = (props: Record<string, unknown>) => ({
    type: 'Feature', properties: props,
  });

  it('реальная форма ответа (замер 11.09) разбирается', () => {
    const data = {
      type: 'FeatureCollection',
      features: [
        feature({
          VolcanoNumber: 300260, VolcanoName: 'Klyuchevskoy', Country: 'Russia',
          VolcanoType: 'Stratovolcano', LastEruption: 2025, Elevation: 4754,
          LatitudeDecimal: 56.056, LongitudeDecimal: 160.642,
        }),
      ],
    };
    const out = parseGvpFeatures(data);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      volcanoNumber: 300260, name: 'Klyuchevskoy', country: 'Russia',
      volcanoType: 'Stratovolcano', lastEruption: 2025, elevationM: 4754,
      lat: 56.056, lng: 160.642,
    });
  });

  it('без имени, номера или координат — не кандидат', () => {
    const data = {
      features: [
        feature({ VolcanoNumber: 1, LatitudeDecimal: 1, LongitudeDecimal: 1 }), // без имени
        feature({ VolcanoName: 'X', LatitudeDecimal: 1, LongitudeDecimal: 1 }), // без номера
        feature({ VolcanoNumber: 2, VolcanoName: 'Y' }), // без координат
      ],
    };
    expect(parseGvpFeatures(data)).toEqual([]);
  });

  it('дедуп по VolcanoNumber', () => {
    const data = {
      features: [
        feature({ VolcanoNumber: 1, VolcanoName: 'A', LatitudeDecimal: 1, LongitudeDecimal: 1 }),
        feature({ VolcanoNumber: 1, VolcanoName: 'A dup', LatitudeDecimal: 1, LongitudeDecimal: 1 }),
      ],
    };
    expect(parseGvpFeatures(data)).toHaveLength(1);
  });

  it('пустой/чужой ответ — пустой список, не исключение', () => {
    expect(parseGvpFeatures(null)).toEqual([]);
    expect(parseGvpFeatures({})).toEqual([]);
    expect(parseGvpFeatures({ features: [] })).toEqual([]);
  });
});

describe('buildVolcanoCrosscheckItems', () => {
  const place = (over: Partial<PlaceInput> = {}): PlaceInput => ({
    id: 'p1', name: 'Ключевской', locationType: 'volcano', lat: 56.06, lng: 160.64, ...over,
  });
  const volcano = (over: Partial<GvpVolcano> = {}): GvpVolcano => ({
    volcanoNumber: 300260, name: 'Klyuchevskoy', country: 'Russia',
    volcanoType: 'Stratovolcano', lastEruption: 2025, elevationM: 4754,
    lat: 56.056, lng: 160.642, ...over,
  });

  it('кандидат — ближайший по расстоянию, БЕЗ фильтра по имени', () => {
    const far = volcano({ volcanoNumber: 1, name: 'Совсем другое имя', lat: 60, lng: 165 });
    const near = volcano({ volcanoNumber: 2, name: 'Klyuchevskoy' });
    const result = buildVolcanoCrosscheckItems([place()], [far, near]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].candidates[0].volcanoNumber).toBe(2);
    expect(result.items[0].nearestKm).toBeLessThan(1);
  });

  it('несколько кандидатов, отсортированы по расстоянию, ограничены limit', () => {
    const vs = [1, 2, 3, 4].map(n => volcano({ volcanoNumber: n, lat: 56.06 + n * 0.1, lng: 160.64 }));
    const result = buildVolcanoCrosscheckItems([place()], vs, { limit: 2 });
    expect(result.items[0].candidates).toHaveLength(2);
    const dists = result.items[0].candidates.map(c => c.distanceKm);
    expect(dists[0]).toBeLessThanOrEqual(dists[1]);
  });

  it('места сортируются по убыванию расстояния до ближайшего кандидата', () => {
    const closeOne = place({ id: 'close', lat: 56.056, lng: 160.642 });
    const farOne = place({ id: 'far', lat: 60, lng: 165 });
    const result = buildVolcanoCrosscheckItems([closeOne, farOne], [volcano()]);
    expect(result.items.map(i => i.placeId)).toEqual(['far', 'close']);
  });

  it('вулкан — протяжённый объект (isExtendedObject)', () => {
    const result = buildVolcanoCrosscheckItems([place()], [volcano()]);
    expect(result.items[0].isExtendedObject).toBe(true);
  });

  it('без координат места или без вулканов ГВП вообще — «не смог», а не 0 совпадений', () => {
    const result = buildVolcanoCrosscheckItems(
      [place({ id: 'no-coords', lat: null, lng: null })],
      [volcano()],
    );
    expect(result.items).toEqual([]);
    expect(result.itemsWithoutCandidatesTotal).toBe(1);

    const result2 = buildVolcanoCrosscheckItems([place()], []);
    expect(result2.itemsWithoutCandidatesTotal).toBe(1);
  });
});
