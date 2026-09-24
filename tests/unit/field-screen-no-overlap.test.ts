// @vitest-environment node
/**
 * Экран «На маршруте» без наложений (24.09, скрин владельца: «наш маршрут
 * похож на помойку»).
 *
 * Что было на скрине:
 *  - развёрнутый нижний лист вставал выше приборного ряда, и колонка
 *    «+ / − / зум / Все места» лежала поверх главной цифры «76.1 км»;
 *  - развёрнутая атрибуция MapLibre торчала белой полосой «…DEM (ESA)»
 *    из-под вкладок — угол top-right на этом экране закрыт;
 *  - плашка азимута компаса лежала поверх оцифровки шкалы и вылезала вниз;
 *  - четвёртое действие резалось краем экрана («Наблк…»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const CLIENT = read('app/planning/_PlanningClient.tsx');
const MAP = read('components/shared/VedarMap.tsx');
const COMPASS = read('components/field/FieldCompass.tsx');
const BAR = read('components/field/FieldActionBar.tsx');

describe('нижний лист не поднимается выше приборного ряда', () => {
  it('ряд с масштабом и компасом измеряется, а не угадывается', () => {
    expect(CLIENT).toMatch(/<div ref=\{instrumentRowRef\} className="relative z-20 flex justify-between/);
    expect(CLIENT).toMatch(/getBoundingClientRect\(\)\.bottom/);
    expect(CLIENT).toMatch(/new ResizeObserver\(measure\)/);
  });

  it('потолок листа — низ ряда, с полом под главную цифру', () => {
    expect(CLIENT).toMatch(/maxHeight: `min\(\$\{sheetOpen \? 60 : 32\}vh, max\(200px, calc\(100dvh - \$\{Math\.round\(instrumentBottom\) \+ 8\}px\)\)\)`/);
  });
});

describe('атрибуция своей карты — там, где её видно', () => {
  it('контрол MapLibre ставится, только если экран не выводит её сам', () => {
    expect(MAP).toMatch(/attributionOutside = false/);
    expect(MAP).toMatch(/if \(!attributionOutside\) \{\s*map\.addControl\(new maplibre\.AttributionControl/);
  });

  it('полевой экран выводит строку и на листе, и в режиме «Карта»', () => {
    expect(CLIENT).toMatch(/\n\s+attributionOutside\n/);
    expect(CLIENT.match(/\{VEDAR_ATTRIBUTION\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(MAP).toMatch(/VEDAR_ATTRIBUTION = '© OpenStreetMap contributors · © Copernicus DEM \(ESA\)'/);
  });
});

describe('компас-бейдж: ни одна надпись не лежит на другой', () => {
  it('мелкая оцифровка только на крупном приборе', () => {
    expect(COMPASS).toMatch(/const BADGE_MAX = 160/);
    expect(COMPASS).toMatch(/\{!badge && DEGREE_LABELS\.map/);
  });

  it('азимут на бейдже — под циферблатом, в потоке, не поверх шкалы', () => {
    expect(COMPASS).toMatch(/className=\{badge \? 'flex flex-col items-center mt-1' : 'absolute inset-x-0/);
  });
});

describe('масштаб и действия не вылезают за свои места', () => {
  it('«+», зум и «−» — одна плашка', () => {
    const i = MAP.indexOf('export function VedarZoomButtons');
    const body = MAP.slice(i, MAP.indexOf('\n}\n', i));
    expect(body).toMatch(/overflow: 'hidden'/);
    expect(body.match(/<button /g)?.length).toBe(2);
  });

  it('развёрнутая панель делит ширину, а не режет последнее действие', () => {
    expect(BAR).toMatch(/\{ flex: '1 1 0', minWidth: 72, maxWidth: 96 \}/);
  });
});
