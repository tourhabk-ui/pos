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
    // Лист: строка по подложке (своя или запасной Leaflet); «Карта»: своя.
    expect(CLIENT).toMatch(/fieldBaseMap\.kind === 'vedar' \? VEDAR_ATTRIBUTION : LEAFLET_ATTRIBUTION/);
    expect(CLIENT.match(/\{VEDAR_ATTRIBUTION\}/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(MAP).toMatch(/VEDAR_ATTRIBUTION = '© OpenStreetMap contributors · © Copernicus DEM \(ESA\)'/);
  });
});

describe('компас-бейдж: ни одна надпись не лежит на другой', () => {
  it('мелкая оцифровка только на крупном приборе', () => {
    expect(COMPASS).toMatch(/const BADGE_MAX = 160/);
    expect(COMPASS).toMatch(/\{!badge && DEGREE_LABELS\.map/);
  });

  it('азимут на бейдже — под циферблатом, в потоке, не поверх шкалы', () => {
    expect(COMPASS).toMatch(/\{targetBearing !== null && badge && \(/);
    const at = COMPASS.indexOf('{targetBearing !== null && badge && (');
    expect(COMPASS.slice(at, at + 900)).not.toMatch(/absolute/);
  });
});

describe('масштаб и действия не вылезают за свои места', () => {
  it('«+», зум и «−» — одна плашка', () => {
    const i = MAP.indexOf('export function VedarZoomButtons');
    const body = MAP.slice(i, MAP.indexOf('\n}\n', i));
    expect(body).toMatch(/overflow: 'hidden'/);
    expect(body.match(/<button /g)?.length).toBe(2);
  });

  it('панель делит ширину, а не режет последнее действие', () => {
    // Обе раскладки делят ширину поровну: развёрнутая — плитка с подписью
    // под ней, свёрнутая (26.09) — плитка в строку на всю долю ширины.
    expect(BAR).toMatch(/\{ flex: '1 1 0', minWidth: 72, maxWidth: 96 \}/);
    expect(BAR).toMatch(/flex: '1 1 0', minWidth: 0, height: TAP/);
  });
});

describe('макет владельца 24.09 («делай по макету»)', () => {
  it('предупреждения — плашкой стекла с кромкой цвета предупреждения, по строке, с кнопкой «Сохранить»', () => {
    expect(CLIENT).toMatch(/Карта не сохранена — офлайн не откроется/);
    const at = CLIENT.indexOf('Предупреждения — отдельной НЕПРОЗРАЧНОЙ плашкой');
    const block = CLIENT.slice(at, at + 3600);
    // Решение владельца 26.09: предупреждения поверх карты — стекло.
    expect(block).toMatch(/data-theme="dark" className="fx-glass-dense mx-3/);
    expect(block).toMatch(/border: '1px solid color-mix\(in srgb, var\(--warning\) 55%, transparent\)'/);
    expect(block).toMatch(/void saveMap\(id\)/);
    expect(block.match(/truncate/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('координатное предупреждение — коротко, полная формулировка в подсказке', () => {
    expect(CLIENT).toMatch(/text: 'Точка не проверена — сверяйтесь с картой'/);
    expect(CLIENT).toMatch(/detail: `Координата точки: \$\{coordSourceLabel\(targetCoordSource\)\}/);
  });

  it('свёрнутый лист: одна строка «не на маршруте», без второй кнопки «развернуть»', () => {
    expect(CLIENT).toMatch(/\{offRouteShort \?\? offRouteNote\}/);
    expect(CLIENT).not.toMatch(/aria-label="Развернуть приборы"/);
  });

  it('кнопки действий подписаны и в свёрнутом листе', () => {
    expect(BAR).toMatch(/\{a\.short \?\? a\.label\}/);
    for (const w of ["short: 'Карта'", "short: 'Место'", "'Трек'", "short: 'Наблюдение'"]) expect(CLIENT).toContain(w);
  });

  it('«Места» — компактной кнопкой рядом с масштабом, со словом', () => {
    expect(CLIENT).toMatch(/<PlacesLayerButton on=\{showAllPlaces\} onToggle=\{toggleAllPlaces\} compact \/>/);
    expect(read('components/field/PlacesLayerButton.tsx')).toMatch(/>Места<\/span>/);
  });
});

describe('запасной Leaflet на «На маршруте» (рендер 24.09 на 412 px)', () => {
  const LEAFLET = readFileSync(join(process.cwd(), 'components/shared/LeafletMap.tsx'), 'utf8');

  it('свои кнопки масштаба у вызывающего — встроенного контрола в углу нет', () => {
    // Встроенный «+/−» в topright ложился на плашку маршрута и компас.
    expect(LEAFLET).toMatch(/if \(!ownZoomButtons\) L\.control\.zoom/);
    expect(CLIENT).toMatch(/attribution=\{showMap\}/);
  });

  it('свёрнутый лист не режет пополам плитки и карточку доверия', () => {
    expect(CLIENT).toMatch(/\{hasRoute && sheetOpen && \(\s*<div className="px-4 pb-2">\s*<TrustCard/);
    expect(CLIENT).toMatch(/\{sheetOpen && \(\s*<div className="grid grid-cols-2 gap-2 p-4">/);
  });
});
