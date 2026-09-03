/**
 * Сторож: сбой кадра MapLibre не оставляет чёрный экран без слов.
 *
 * 03.09, скрин владельца из Петропавловска после мержа гипсометрии
 * (8925898c): область карты цвета фона (14,17,22), след у точки нарисован,
 * ни строки диагноза. По коду MapLibre 6.6 «Could not compile fragment
 * shader» бросается из `_render` и пробрасывается `triggerRepaint` как
 * необработанное исключение кадра — события `error` нет, холст замирает,
 * сторож молчания доволен (тайлы пришли). Единственный новый шейдер того
 * мержа — слой `color-relief`.
 *
 * Держит три вещи: (1) ошибка кадра ловится у окна и выводится на экран;
 * (2) слои гипсометрии снимаются, кадр перезапрашивается, соседям слой не
 * подкладывается; (3) пустой по построению вид (масштаб мельче пакета,
 * вид вне районов) называется словами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const CLIENT = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('VedarMap: сбой кадра — не чёрное поле', () => {
  it('необработанная ошибка окна ловится и фильтруется по следу MapLibre/WebGL', () => {
    expect(MAP).toMatch(/window\.addEventListener\('error', onWindowError\)/);
    expect(MAP).toMatch(/window\.removeEventListener\('error', onWindowError\)/);
    expect(MAP).toMatch(/\/shader\|program\|webgl\|maplibre\/i\.test\(text\)/);
  });

  it('гипсометрия снимается со стиля, кадр перезапрашивается, причина — на экран', () => {
    const at = MAP.indexOf('onWindowError = (ev: ErrorEvent) =>');
    expect(at).toBeGreaterThan(0);
    const body = MAP.slice(at, at + 1600);
    expect(body).toMatch(/l\.type === 'color-relief'/);
    expect(body).toMatch(/reliefOffRef\.current = true/);
    expect(body).toMatch(/m\.removeLayer\(id\)/);
    expect(body).toMatch(/m\.triggerRepaint\(\)/);
    expect(body).toMatch(/setReliefNote\(`гипсометрия отключена, рельеф тенью/);
    // Не гипсометрия — всё равно не молчим.
    expect(body).toMatch(/setMapError\(`сбой кадра:/);
  });

  it('после отключения соседям гипсометрию не подкладывают', () => {
    expect(MAP).toMatch(/if \(reliefOffRef\.current && layer\.type === 'color-relief'\) continue;/);
  });

  it('заметки уходят наружу тем же каналом, что ошибка и диагноз', () => {
    expect(MAP).toMatch(/onDiagnosticRef\.current\?\.\(mapError \?\? diag \?\? reliefNote \?\? viewNote \?\? null\)/);
  });

  it('пустой по построению вид назван словами: зум мельче пакета, вид вне районов', () => {
    expect(MAP).toMatch(/export const PACK_MIN_ZOOM = 8;/);
    expect(MAP).toMatch(/if \(zoom < PACK_MIN_ZOOM\)/);
    expect(MAP).toMatch(/масштаб мельче пакета/);
    expect(MAP).toMatch(/else if \(hit\.length === 0\)/);
    expect(MAP).toMatch(/вид вне всех районов реестра — здесь пакета карты нет/);
  });

  it('нижний зум пакета в карте совпадает со сборкой', () => {
    const terrain = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_terrain.py'), 'utf-8');
    const vector = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_vector.sh'), 'utf-8');
    expect(terrain).toMatch(/^MINZOOM = 8$/m);
    expect(vector).toMatch(/--minimum-zoom=8/);
  });

  it('приборная колонка не дописывает «не отрисовалась» — заметка может прийти и от рисующей карты', () => {
    const at = CLIENT.indexOf("fieldBaseMap.kind === 'vedar' && vedarDiag");
    expect(at).toBeGreaterThan(0);
    expect(CLIENT.slice(at, at + 500)).not.toMatch(/не отрисовалась: \{vedarDiag\}/);
  });
});
