/**
 * Сверка places с OSM — чистая логика.
 *
 * Правило то же, что у place-link.ts: НЕТ фильтра по расстоянию, только
 * сортировка. Сегодняшние (10.09) находки лежат на 17, ~20-25 и 506 км
 * одновременно с честными совпадениями на единицы метров — единого порога,
 * отделяющего ошибку от однофамильца, не существует.
 */
import { describe, it, expect } from 'vitest';
import {
  buildOsmCrosscheckQuery, parseOsmFeatures, buildCrosscheckItems,
  type PlaceInput, type OsmFeature, type SimilarityRow,
} from '@/lib/geo/osm-crosscheck';

describe('Overpass-запрос', () => {
  it('содержит bbox, вайлдкард по ключу тега и out center', () => {
    const q = buildOsmCrosscheckQuery({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(q).toContain('50,155,64,167');
    expect(q).toMatch(/nwr\[~"\^\(natural\|waterway\|place\|tourism\|historic\|leisure\)\$"~"\."\]/);
    expect(q).toContain('boundary"="protected_area"');
    expect(q).toContain('man_made"="lighthouse"');
    expect(q).toContain('out center;');
    expect(q).not.toContain('out geom;');
  });
});

describe('разбор ответа Overpass', () => {
  it('node берёт lat/lon напрямую', () => {
    const out = parseOsmFeatures({
      elements: [{ type: 'node', id: 1, lat: 53.1, lon: 158.1, tags: { name: 'Тест', natural: 'peak' } }],
    });
    expect(out).toEqual([{ id: 1, kind: 'node', name: 'Тест', lat: 53.1, lng: 158.1, matchedTag: 'natural=peak' }]);
  });

  it('way/relation берут center, не геометрию', () => {
    const out = parseOsmFeatures({
      elements: [{ type: 'way', id: 2, center: { lat: 53.2, lon: 158.2 }, tags: { name: 'Мыс', natural: 'cape' } }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'way', lat: 53.2, lng: 158.2, matchedTag: 'natural=cape' });
  });

  it('без имени или без координат — отбрасывается', () => {
    const out = parseOsmFeatures({
      elements: [
        { type: 'node', id: 3, lat: 53.1, lon: 158.1, tags: {} },
        { type: 'way', id: 4, tags: { name: 'Без центра' } },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('дедуп по kind+id', () => {
    const el = { type: 'node', id: 5, lat: 53.1, lon: 158.1, tags: { name: 'Дубль' } };
    const out = parseOsmFeatures({ elements: [el, el] });
    expect(out).toHaveLength(1);
  });
});

describe('сборка кандидатов — сегодняшние (10.09) находки', () => {
  const golubyeOzera: PlaceInput = {
    id: 'golubye', name: 'Голубые озёра', locationType: 'lake',
    lat: 53.1891933, lng: 158.3822536,
  };
  const sivuchi: PlaceInput = {
    id: 'sivuchi', name: 'Лежбище сивучей', locationType: 'other',
    lat: 53.019008, lng: 158.647674,
  };
  const sinichkino: PlaceInput = {
    id: 'sinichkino', name: 'Синичкино', locationType: 'viewpoint',
    lat: 53.0, lng: 158.6,
  };

  const golubyeOsm: OsmFeature = {
    id: 100, kind: 'way', name: 'Голубые озёра', lat: 53.1561328, lng: 158.1331722,
    matchedTag: 'natural=water',
  };
  const mysSivuchiy: OsmFeature = {
    id: 200, kind: 'node', name: 'мыс Сивучий', lat: 56.7367779, lng: 163.2255911,
    matchedTag: 'natural=cape',
  };
  const sinichkinoOsm: OsmFeature = {
    // ~12 м от места — честное совпадение
    id: 300, kind: 'node', name: 'Синичкино', lat: 53.00011, lng: 158.60011,
    matchedTag: 'place=locality',
  };

  const places = [golubyeOzera, sivuchi, sinichkino];
  const features = [golubyeOsm, mysSivuchiy, sinichkinoOsm];
  const simRows: SimilarityRow[] = [
    { placeId: 'golubye', osmId: 100, osmKind: 'way', sim: 1.0 },
    { placeId: 'sivuchi', osmId: 200, osmKind: 'node', sim: 0.71 },
    { placeId: 'sinichkino', osmId: 300, osmKind: 'node', sim: 1.0 },
  ];

  it('ни один кандидат не отфильтрован расстоянием — 506 км остаётся в списке', () => {
    const { items } = buildCrosscheckItems(places, features, simRows);
    const sivuchiItem = items.find(i => i.placeId === 'sivuchi');
    expect(sivuchiItem).toBeDefined();
    expect(sivuchiItem!.candidates[0].distanceKm).toBeGreaterThan(500);
  });

  it('порядок — по расстоянию до ближайшего СИЛЬНОГО совпадения: дальнее первым, честное — в хвосте', () => {
    const { items } = buildCrosscheckItems(places, features, simRows);
    expect(items.map(i => i.placeId)).toEqual(['sivuchi', 'golubye', 'sinichkino']);
    expect(items[0].nearestStrongKm).toBeGreaterThan(500);
    expect(items[items.length - 1].nearestStrongKm).toBeLessThan(1);
  });

  it('слабое совпадение не выдаёт себя за находку: уходит в хвост с nearestStrongKm=null', () => {
    // Урок run 3 (10.09): «Водопад Ольга» → пик «Водопадная» за 1357 км при
    // sim 0.39 стоял ВЫШЕ настоящих ошибок. Слабый кандидат виден, но не
    // ранжирует место как улику.
    const olga: PlaceInput = { id: 'olga', name: 'Водопад Ольга', locationType: 'waterfall', lat: 52.5, lng: 158.0 };
    const vodopadnaya: OsmFeature = { id: 400, kind: 'node', name: 'Водопадная', lat: 64.0, lng: 166.0, matchedTag: 'natural=peak' };
    const { items, itemsStrongTotal, itemsWeakOnlyTotal } = buildCrosscheckItems(
      [...places, olga], [...features, vodopadnaya],
      [...simRows, { placeId: 'olga', osmId: 400, osmKind: 'node', sim: 0.39 }],
    );
    expect(items.map(i => i.placeId)).toEqual(['sivuchi', 'golubye', 'sinichkino', 'olga']);
    const olgaItem = items[3];
    expect(olgaItem.nearestStrongKm).toBeNull();
    expect(olgaItem.candidates[0].distanceKm).toBeGreaterThan(1000);
    expect(itemsStrongTotal).toBe(3);
    expect(itemsWeakOnlyTotal).toBe(1);
  });

  it('внутри места кандидаты идут по похожести, при равной — ближайший первым', () => {
    const far: OsmFeature = { id: 101, kind: 'node', name: 'Голубые озёра', lat: 60.0, lng: 165.0, matchedTag: 'natural=water' };
    const { items } = buildCrosscheckItems(
      [golubyeOzera], [golubyeOsm, far],
      [
        { placeId: 'golubye', osmId: 100, osmKind: 'way', sim: 1.0 },
        { placeId: 'golubye', osmId: 101, osmKind: 'node', sim: 1.0 },
      ],
    );
    expect(items[0].candidates.map(c => c.osmId)).toEqual([100, 101]);
    // Ближайший сильный — 17 км, а не 800: улика считается по ближайшему.
    expect(items[0].nearestStrongKm).toBeLessThan(20);
  });

  it('места без кандидата выше порога — в itemsWithoutCandidatesTotal, не путаются с находками', () => {
    const { items, itemsWithoutCandidatesTotal } = buildCrosscheckItems(
      places, features, simRows.filter(r => r.placeId !== 'sinichkino'),
    );
    expect(items.map(i => i.placeId)).not.toContain('sinichkino');
    expect(itemsWithoutCandidatesTotal).toBe(1);
  });

  it('isExtendedObject пробрасывается как есть (протяжённый объект — не точка)', () => {
    const { items } = buildCrosscheckItems(places, features, simRows);
    const golubyeItem = items.find(i => i.placeId === 'golubye')!;
    const sinichkinoItem = items.find(i => i.placeId === 'sinichkino')!;
    expect(golubyeItem.isExtendedObject).toBe(true); // 'lake' не в POINT_TYPES
    expect(sinichkinoItem.isExtendedObject).toBe(false); // 'viewpoint' — точка
  });
});
