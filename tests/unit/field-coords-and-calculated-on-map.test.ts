/**
 * Полевой экран 05.09 («го» владельца): координаты на экране и автопуть на
 * большой карте. Сторож держит:
 *   - строка «Центр карты» появляется только когда карта сдвинута от человека
 *     (или фикса нет) — иначе она повторяла бы строку «Я»;
 *   - ручка VedarMap несёт центр, подписку на сдвиг и подгонку под линию —
 *     чип и автопуть читают карту через ту же ручку, что кнопки масштаба;
 *   - стиль рисует род 'calculated' цветом из line-standard и концы автопути;
 *   - экран ставит чип в обоих местах (приборный ряд и слот на карте), кладёт
 *     автопуть в vedarLines, а Leaflet-карточку заменяет кнопкой на своей карте;
 *   - «На автомобиле» — по умолчанию: иначе почти каждый получал бы
 *     «Построение пути пока недоступно» при живом графе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { centerRowVisible, CENTER_APART_M } from '@/components/field/FieldCoords';
import { buildVedarStyle, type VedarStyleSources } from '@/lib/map/vedar-style';
import { calculatedCarLine } from '@/lib/map/line-standard';

const ROOT = process.cwd();
const TRAIL = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const MAP = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');

describe('чип координат', () => {
  const me = { lat: 53.2589, lng: 158.8311 };
  it('строка центра — только когда карта сдвинута дальше CENTER_APART_M или фикса нет', () => {
    expect(centerRowVisible(me, me)).toBe(false);
    expect(centerRowVisible(me, { lat: me.lat + 0.0001, lng: me.lng })).toBe(false);
    expect(centerRowVisible(me, { lat: me.lat + 0.01, lng: me.lng })).toBe(true);
    expect(centerRowVisible(null, me)).toBe(true);
    expect(centerRowVisible(me, null)).toBe(false);
    expect(CENTER_APART_M).toBeGreaterThan(10);
  });

  it('экран ставит чип в приборном ряду и в слоте карты, с фиксом и центром с живой карты', () => {
    expect(TRAIL.match(/<FieldCoords fix=\{coords \? \{ lat: coords\.lat, lng: coords\.lng \} : null\} center=\{viewCenter\} \/>/g)?.length).toBe(2);
    expect(TRAIL).toMatch(/return mapCtl\.onMove\(setViewCenter\)/);
    expect(MAP).toMatch(/getCenter\(\): \{ lat: number; lng: number \}/);
    expect(MAP).toMatch(/map\.on\('moveend', tick\)/);
    expect(MAP).toMatch(/\{controlsSlot\}/);
  });
});

describe('автопуть на большой карте', () => {
  const sources: VedarStyleSources = {
    terrainUrl: 'pmtiles://https://example.test/x.terrain.pmtiles',
    contoursUrl: 'https://example.test/x.contours.geojson',
    terrainMaxZoom: 13,
    attribution: '© Copernicus DEM (ESA)',
    glyphsUrl: 'https://example.test/glyphs/{fontstack}/{range}.pbf',
  };

  it('стиль: слой route-calculated цветом line-standard и концы calculated_end с подписью', () => {
    const style = buildVedarStyle('dark', sources) as { layers: Array<{ id: string; type: string; filter?: unknown; paint?: Record<string, unknown> }> };
    const line = style.layers.find((l) => l.id === 'route-calculated');
    expect(line?.type).toBe('line');
    expect(line?.filter).toEqual(['==', ['get', 'kind'], 'calculated']);
    expect(line?.paint?.['line-color']).toBe(calculatedCarLine().style.color);
    expect(style.layers.find((l) => l.id === 'route-calculated-end')?.type).toBe('circle');
    expect(style.layers.find((l) => l.id === 'route-calculated-end-label')?.type).toBe('symbol');
    // Без глифов подписи нет, а концы остаются.
    const noGlyphs = buildVedarStyle('light', { ...sources, glyphsUrl: null }) as { layers: Array<{ id: string }> };
    expect(noGlyphs.layers.some((l) => l.id === 'route-calculated-end-label')).toBe(false);
    expect(noGlyphs.layers.some((l) => l.id === 'route-calculated-end')).toBe(true);
  });

  it('экран кладёт автопуть в vedarLines родом calculated, концы — точками, и подводит кадр один раз', () => {
    expect(TRAIL).toMatch(/out\.push\(\{ coordinates: calc\.geometry\.coordinates, kind: 'calculated' \}\)/);
    expect(TRAIL).toMatch(/kind: 'calculated_end'/);
    expect(TRAIL).toMatch(/mapCtl\.fitLine\(calc\.geometry\.coordinates\)/);
    expect(TRAIL).toMatch(/points=\{vedarPoints\}/);
    expect(MAP).toMatch(/fitLine\(coordinates: Array<\[number, number\]>\): void/);
  });

  it('на своей карте Leaflet-карточки нет — кнопка «Показать путь на карте»; Leaflet остаётся запасной подложке', () => {
    const branchAt = TRAIL.indexOf('calculatedPreview && calculatedPreviewMap ? (');
    const branch = TRAIL.slice(branchAt, TRAIL.indexOf(') : preview && previewMap ? (', branchAt));
    expect(branch).toContain("fieldBaseMap.kind === 'vedar' && mapCtl ? (");
    expect(branch).toContain('Показать путь на карте');
    expect(branch).toContain('<LeafletMap markers={calculatedPreviewMap.markers}');
  });

  it('«На автомобиле» — по умолчанию', () => {
    expect(TRAIL).toMatch(/useState<RouteBuildMode>\('car'\)/);
    expect(TRAIL).not.toMatch(/useState<RouteBuildMode>\('foot'\)/);
  });
});
