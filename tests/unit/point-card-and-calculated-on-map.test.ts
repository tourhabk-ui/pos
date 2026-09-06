/**
 * Полевой экран 05.09: карточка точки по образцу навигатора и автопуть на
 * большой карте. Сторож держит:
 *   - тап по карте и по своей точке идут в карточку, булавка — в стиль;
 *   - карточка: координаты с переключением формата тапом по числу,
 *     копирование, «Проложить сюда» (только для булавки и только с фиксом),
 *     передача в чужой навигатор тем же NavigateTo;
 *   - прокладка с карточки идёт через ТУ ЖЕ машину build(), найденный
 *     автопуть открывается на карте сам, отказ — словами сервера;
 *   - стиль рисует род 'calculated' цветом line-standard и концы автопути;
 *   - Leaflet-карточку на своей карте заменяет кнопка; «На автомобиле» —
 *     по умолчанию.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearingDeg, distanceLabel } from '@/components/field/PointCard';
import { buildVedarStyle, type VedarStyleSources } from '@/lib/map/vedar-style';
import { calculatedCarLine } from '@/lib/map/line-standard';

const ROOT = process.cwd();
const TRAIL = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const MAP = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'components/field/PointCard.tsx'), 'utf-8');

describe('карточка точки — как в навигаторе', () => {
  it('азимут и расстояние словами', () => {
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 54, lng: 158 }))).toBe(0);
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 53, lng: 159 }))).toBe(90);
    expect(distanceLabel(640)).toBe('640 м');
    expect(distanceLabel(8700)).toBe('8.7 км');
  });

  it('карта отдаёт тап по карте и по своей точке наружу, булавка — свойством kind=pin', () => {
    expect(MAP).toMatch(/map\.on\('click', \(e\) => \{ onMapClickRef\.current\?\.\(\{ lat: e\.lngLat\.lat, lng: e\.lngLat\.lng \}\); \}\)/);
    expect(MAP).toMatch(/el\.addEventListener\('click', \(ev\) => \{ ev\.stopPropagation\(\); onUserClickRef\.current\?\.\(\); \}\)/);
    expect(MAP).toMatch(/properties: \{ kind: 'pin' \}/);
  });

  it('карточка: число — кнопка формата, копирование, «Проложить сюда» и NavigateTo', () => {
    expect(CARD).toMatch(/onClick=\{toggleFormat\}/);
    expect(CARD).toMatch(/navigator\.clipboard\?\.writeText\(text\)/);
    expect(CARD).toContain('Проложить сюда');
    expect(CARD).toMatch(/disabled=\{!me \|\| route\.phase === 'building'\}/);
    expect(CARD).toMatch(/<NavigateTo to=\{\{ lat: point\.lat, lng: point\.lng, name: title \}\}/);
    // Стекло — слой контекста над картой (§5), не непрозрачный прибор.
    expect(CARD).toContain('fx-glass-dense');
  });

  it('экран: тапы → pointCard, прокладка с карточки — через ту же build(), найденный путь открывается сам', () => {
    expect(TRAIL).toMatch(/onMapClick=\{p => setPointCard\(\{ kind: 'pin', \.\.\.p \}\)\}/);
    expect(TRAIL).toMatch(/onUserClick=\{\(\) => \{ if \(coords\) setPointCard\(\{ kind: 'me'/);
    expect(TRAIL).toMatch(/setSelectedOrigin\(\{ kind: 'current', lat: coords\.lat, lon: coords\.lng/);
    expect(TRAIL).toMatch(/setSelectedDestination\(\{ destination: \{ kind: 'coordinate', lat: pointCard\.lat, lon: pointCard\.lng/);
    expect(TRAIL).toMatch(/openPreview\(routeOptionToPreview\(withLine\)\)/);
    expect(TRAIL).toMatch(/text: r\.status === 'failed' \? r\.message : r\.reason/);
    expect(TRAIL).toMatch(/<PointCard kind=\{pointCard\.kind\}/);
    // Коробки координат больше нет.
    expect(TRAIL).not.toContain('FieldCoords');
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

  it('стиль: route-calculated цветом line-standard, концы calculated_end с подписью, булавка route-pin', () => {
    const style = buildVedarStyle('dark', sources) as { layers: Array<{ id: string; type: string; filter?: unknown; paint?: Record<string, unknown> }> };
    const line = style.layers.find((l) => l.id === 'route-calculated');
    expect(line?.type).toBe('line');
    expect(line?.filter).toEqual(['==', ['get', 'kind'], 'calculated']);
    expect(line?.paint?.['line-color']).toBe(calculatedCarLine().style.color);
    expect(style.layers.find((l) => l.id === 'route-calculated-end')?.type).toBe('circle');
    expect(style.layers.find((l) => l.id === 'route-calculated-end-label')?.type).toBe('symbol');
    expect(style.layers.find((l) => l.id === 'route-pin')?.type).toBe('circle');
    const noGlyphs = buildVedarStyle('light', { ...sources, glyphsUrl: null }) as { layers: Array<{ id: string }> };
    expect(noGlyphs.layers.some((l) => l.id === 'route-calculated-end-label')).toBe(false);
    expect(noGlyphs.layers.some((l) => l.id === 'route-calculated-end')).toBe(true);
  });

  it('экран кладёт автопуть в vedarLines родом calculated, концы — точками, и подводит кадр', () => {
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
  });
});
