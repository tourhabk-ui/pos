/**
 * Сверка places с OSM — чистая логика.
 *
 * Правило то же, что у place-link.ts: НЕТ фильтра по расстоянию, только
 * сортировка. Сегодняшние (10.09) находки лежат на 17, ~20-25 и 506 км
 * одновременно с честными совпадениями на единицы метров — единого порога,
 * отделяющего ошибку от однофамильца, не существует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOsmCrosscheckQuery, parseOsmFeatures, buildCrosscheckItems,
  type PlaceInput, type OsmFeature, type SimilarityRow,
  isOsmPointTag, geojsonFeatureToElement, matchesCrosscheckTags,
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

describe('точечный тёзка OSM — улика при любом нашем роде (03.10, «Гора Замок»)', () => {
  // 10.09 сверка нашла «6.2 км → Замок (natural=peak)», но пометка
  // «[протяжённый]» из нашего рода «mountain» спрятала её при разборе.
  const zamok = { id: 'zamok', name: 'Гора Замок', locationType: 'mountain', lat: 53.182842, lng: 158.286467 };
  const peak = { id: 7178874096, kind: 'node' as const, name: 'Замок', lat: 53.1778026, lng: 158.1944257, matchedTag: 'natural=peak' };

  it('гора «протяжённая», но вершина OSM — точка: расстояние до неё отдаётся отдельной уликой', () => {
    const r = buildCrosscheckItems([zamok], [peak], [{ placeId: 'zamok', osmId: peak.id, osmKind: 'node', sim: 0.55 }]);
    expect(r.items[0].isExtendedObject).toBe(true);
    expect(r.items[0].nearestStrongPointKm).toBeCloseTo(6.2, 1);
  });

  it('смотровая площадка с именем озера — не точка самого озера', () => {
    const lake = { id: 'k', name: 'Озеро Костакан', locationType: 'lake', lat: 53.295, lng: 158.2786 };
    const vp = { id: 1, kind: 'node' as const, name: 'Озеро Костакан', lat: 53.836, lng: 158.0485, matchedTag: 'tourism=viewpoint' };
    const r = buildCrosscheckItems([lake], [vp], [{ placeId: 'k', osmId: 1, osmKind: 'node', sim: 1 }]);
    expect(r.items[0].nearestStrongKm).toBeGreaterThan(50);
    expect(r.items[0].nearestStrongPointKm).toBeNull();
  });

  it('точечные теги: вершина, вулкан, водопад, источник, маяк, памятник', () => {
    for (const t of ['natural=peak', 'natural=volcano', 'waterway=waterfall', 'natural=hot_spring', 'man_made=lighthouse', 'historic=memorial']) {
      expect(isOsmPointTag(t)).toBe(true);
    }
    for (const t of ['natural=water', 'leisure=nature_reserve', 'tourism=viewpoint', 'natural=ridge', 'place=locality']) {
      expect(isOsmPointTag(t)).toBe(false);
    }
  });

  it('workflow печатает список точечных расхождений, а не только общий', () => {
    const wf = readFileSync(join(process.cwd(), '.github/workflows/places-osm-crosscheck.yml'), 'utf8');
    expect(wf).toContain('Точечный тёзка OSM дальше 1 км');
    expect(wf).toContain("nearestStrongPointKm");
  });
});

describe('выгрузка Geofabrik → форма Overpass (03.10)', () => {
  it('узел — точка; линия и область — середина охвата, как `out center`', () => {
    const node = geojsonFeatureToElement({ id: 'n7178874096', properties: { name: 'Замок', natural: 'peak', ele: '1036' }, geometry: { type: 'Point', coordinates: [158.1944257, 53.1778026] } });
    expect(node).toEqual({ type: 'node', id: 7178874096, lat: 53.1778026, lon: 158.1944257, tags: { name: 'Замок', natural: 'peak', ele: '1036' } });
    const lake = geojsonFeatureToElement({ id: 'w5', properties: { name: 'Озеро', natural: 'water' }, geometry: { type: 'Polygon', coordinates: [[[158, 53], [158.2, 53], [158.2, 53.4], [158, 53.4], [158, 53]]] } });
    expect(lake?.center).toEqual({ lat: 53.2, lon: 158.1 });
    expect(parseOsmFeatures({ elements: [node, lake] })).toHaveLength(2);
  });

  it('id без рода и пустая геометрия — не элемент', () => {
    expect(geojsonFeatureToElement({ id: 'a12', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } })).toBeNull();
    expect(geojsonFeatureToElement({ id: 'n1', properties: {}, geometry: null })).toBeNull();
  });

  it('отбор тот же, что у запроса Overpass: ключ из списка или заповедник/маяк, и обязательно имя', () => {
    expect(matchesCrosscheckTags({ name: 'Замок', natural: 'peak' })).toBe(true);
    expect(matchesCrosscheckTags({ name: 'Налычево', boundary: 'protected_area' })).toBe(true);
    expect(matchesCrosscheckTags({ name: 'Маяк', man_made: 'lighthouse' })).toBe(true);
    expect(matchesCrosscheckTags({ natural: 'peak' })).toBe(false);
    expect(matchesCrosscheckTags({ name: 'Дом', building: 'yes' })).toBe(false);
    expect(matchesCrosscheckTags({ name: 'Граница', boundary: 'administrative' })).toBe(false);
  });

  it('ключи предиката совпадают с ключами запроса Overpass', () => {
    const q = buildOsmCrosscheckQuery({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(q).toContain('natural|waterway|place|tourism|historic|leisure');
    expect(q).toContain('"boundary"="protected_area"');
    expect(q).toContain('"man_made"="lighthouse"');
  });
});
