/**
 * Дыра покрытия DEM — свой цвет, не цвет воды и не цвет суши (04.09).
 *
 * Жалоба с поля: «не всё прорисовалось» — большие ровные участки карты
 * визуально неотличимы друг от друга. Причина лежала в кодировке:
 * `encode_terrain_rgb` (scripts/map-tiles/build_terrain.py) писал пропуск
 * DEM (море, дыра покрытия Copernicus) как высоту 0.0 — БАЙТ В БАЙТ то же,
 * что настоящая низкая суша на уровне моря. Клиент читает только байты
 * terrain-RGB: ни hillshade, ни color-relief не видят происхождения нуля,
 * и «не знаю» рисовалось как уверенное «здесь земля» либо «здесь море» —
 * смотря какая ступень гипсометрии стояла на нуле (§4.0 CLAUDE.md).
 *
 * Фикс — сигнальная высота NODATA_SENTINEL_M, заведомо ниже любой точки
 * Камчатки, со СВОЕЙ ступенью цвета в обеих палитрах. Число одно на печь
 * (Python) и на чтение (TS-стиль) — сторож держит их в паре, как и другие
 * синхронизированные константы конвейера (MAXZOOM и т.п.).
 *
 * Пересборка ВСЕХ уже залитых пакетов (районы, клетки сетки, обзор) —
 * отдельная, более медленная работа: сам байт в уже выложенных архивах эта
 * правка не меняет, пока пакет не перепечён этим кодом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVedarStyle, vedarMapPalette, NODATA_SENTINEL_M, NODATA_TRANSPARENT } from '@/lib/map/vedar-style';

const ROOT = process.cwd();
const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_terrain.py'), 'utf-8');

describe('сигнальная высота «нет данных» — одно число на печь и на чтение', () => {
  it('NODATA_SENTINEL_M в стиле равен константе конвейера', () => {
    const m = PY.match(/^NODATA_SENTINEL_M = (-?[\d.]+)$/m);
    expect(m, 'NODATA_SENTINEL_M в build_terrain.py не найден').toBeTruthy();
    expect(NODATA_SENTINEL_M).toBe(Number(m![1]));
  });

  it('кодировщик пишет сигнальную высоту, а не 0.0, для пропуска DEM', () => {
    expect(PY).toMatch(/h = np\.where\(np\.isnan\(heights\), NODATA_SENTINEL_M, heights\)/);
    expect(PY).not.toMatch(/h = np\.where\(np\.isnan\(heights\), 0\.0, heights\)/);
  });

  it('сигнальная высота — заведомо ниже любой точки края (суша начинается от 0)', () => {
    expect(NODATA_SENTINEL_M).toBeLessThan(0);
  });

  it('ступень NODATA_SENTINEL_M — прозрачная, а «не знаю» — фон карты, не цвет воды и не суши', () => {
    for (const theme of ['dark', 'light'] as const) {
      const style = buildVedarStyle(theme, {
        terrainUrl: 'pmtiles://https://s3.example.ru/b/map-packs/r.terrain.pmtiles',
        contoursUrl: 'https://s3.example.ru/b/map-packs/r.contours.geojson',
        terrainMaxZoom: 13,
        attribution: '© Copernicus DEM (ESA)',
        glyphsUrl: null,
        glyphsFont: 'Noto Sans Regular',
        osmUrls: {},
      });
      const relief = style.layers.find(l => l.id === 'relief') as {
        paint: { 'color-relief-color': unknown[] };
      };
      const expr = relief.paint['color-relief-color'] as unknown[];
      // ['interpolate', ['linear'], ['elevation'], m0, c0, m1, c1, ...]
      const stops = expr.slice(3);
      const idx = stops.indexOf(NODATA_SENTINEL_M);
      expect(idx, 'ступень NODATA_SENTINEL_M не найдена в color-relief').toBeGreaterThanOrEqual(0);
      const nodataColor = stops[idx + 1] as string;
      // 05.09: дыра одного пакета закрывала данные соседа полосой в полтайла
      // (тайл z8 заходит за границу клетки). Ступень прозрачна, «не знаю»
      // лежит фоном — и отличается от воды и от суши.
      expect(nodataColor, theme).toBe(NODATA_TRANSPARENT);
      const waterColor = stops[idx - 1] as string;
      const seaLevelColor = stops[stops.indexOf(0.5) + 1] as string;
      const bg = (style.layers.find(l => l.id === 'bg') as { paint: Record<string, string> }).paint['background-color'];
      expect(bg, theme).not.toBe(waterColor);
      expect(bg, theme).not.toBe(seaLevelColor);
      expect(bg, theme).toBe(vedarMapPalette(theme).nodata);
    }
  });
});
