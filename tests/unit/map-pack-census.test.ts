/**
 * Перепись архивов рельефа (05.09, прогон снимков 8).
 *
 * Сторож держит одно: формула охвата тайлов в TypeScript даёт ТЕ ЖЕ числа,
 * что tile_range() в build_terrain.py — иначе перепись сравнивала бы архив
 * с выдуманным ожиданием и краснела/зеленела не по делу. Эталон — лог живой
 * сборки cell-54n158e (прогон 413, 05.09): z8 6 · z9 12 · z10 24 · z11 77 ·
 * z12 273 · z13 960, всего 1352.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tileRange, expectedTileCounts, packZoomRange, parseProbe, terrainRgbHeight, describePng, NODATA_SENTINEL_M,
} from '@/scripts/map-tiles/pack-census';

const ROOT = process.cwd();
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-snapshot.yml'), 'utf-8');
const MARKER = JSON.parse(readFileSync(join(ROOT, '.github/triggers/map-pack-snapshot.json'), 'utf-8')) as { probe?: unknown };

describe('перепись архива — та же формула охвата, что у сборщика', () => {
  it('cell-54n158e: числа из лога сборки 413', () => {
    const bbox = { west: 158, south: 54, east: 159, north: 55 };
    expect(expectedTileCounts(bbox, 8, 13)).toEqual({ 8: 6, 9: 12, 10: 24, 11: 77, 12: 273, 13: 960 });
    expect(Object.values(expectedTileCounts(bbox, 8, 13)).reduce((a, b) => a + b, 0)).toBe(1352);
  });

  it('tileRange усекает к нулю, как int() в Python, и включает оба конца', () => {
    // z9 для 51n158e: x 480..482, y 169..172 — тайл 481/169 в охвате, хотя
    // его верхняя кромка выше 52°: усечение int(), а не округление.
    const [x0, x1, y0, y1] = tileRange({ west: 158, south: 51, east: 159, north: 52 }, 9);
    expect([x0, x1]).toEqual([480, 482]);
    expect(y0).toBe(169);
    expect(y1).toBeGreaterThanOrEqual(171);
  });

  it('зумы пакета — из реестра: обзор z4-7, клетка и район z8-13', () => {
    expect(packZoomRange('krai-overview')).toEqual({ minzoom: 4, maxzoom: 7 });
    expect(packZoomRange('cell-54n158e')).toEqual({ minzoom: 8, maxzoom: 13 });
    expect(packZoomRange('avacha-group')).toEqual({ minzoom: 8, maxzoom: 13 });
  });

  it('--probe разбирается как pack:z/x/y, кривая запись — отказ словами', () => {
    expect(parseProbe('cell-52n157e:9/480/167')).toEqual({ pack: 'cell-52n157e', zxy: [9, 480, 167] });
    expect(() => parseProbe('cell-52n157e/9/480/167')).toThrow(/pack:z\/x\/y/);
  });

  it('высота terrain-RGB и сигнальная дыра — как в build_terrain.py', () => {
    // -500 м = сигнал «нет данных»: (−500 + 10000) * 10 = 95000 = 0x017318.
    expect(terrainRgbHeight(0x01, 0x73, 0x18)).toBe(NODATA_SENTINEL_M);
    expect(terrainRgbHeight(0x01, 0x86, 0xa0)).toBe(0);
    expect(describePng(Buffer.from('not a png')).png).toBe(false);
  });

  it('workflow снимков зовёт перепись до кадров, с пробами из маркера, и кладёт её журнал в ветку кадров', () => {
    expect(WF).toContain('scripts/map-tiles/pack-census.ts');
    expect(WF.indexOf('pack-census.ts')).toBeLessThan(WF.indexOf('snapshot-packs.ts'));
    expect(WF).toMatch(/--probe \$\{\{ steps\.cfg\.outputs\.probe \}\}/);
    expect(WF).toContain('census.log');
    if (MARKER.probe !== undefined) {
      expect(Array.isArray(MARKER.probe)).toBe(true);
      for (const p of MARKER.probe as unknown[]) expect(() => parseProbe(String(p))).not.toThrow();
    }
  });
});
