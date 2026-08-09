/**
 * Конвейер контура берега: данные из источника, а не из головы.
 *
 * Владелец 09.08: «теперь контур Камчатки нужно постараться но сделать».
 * Прежний контур был ручной ломаной из двух десятков узлов на весь
 * полуостров — в круге радиусом 200 км прямые между ними резали скоп через
 * воду. Рисовать берег по памяти на экране безопасности нельзя (CLAUDE.md §8),
 * поэтому он приходит из Natural Earth (общественное достояние) конвейером на
 * раннере: из песочницы разработки интернета нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const SCRIPT = join(ROOT, 'scripts/build-kamchatka-coastline.py');

function run(features: unknown, eps = '0.01', maxp = '3000') {
  const dir = mkdtempSync(join(tmpdir(), 'coast-'));
  const inPath = join(dir, 'in.geojson');
  const outPath = join(dir, 'out.json');
  writeFileSync(inPath, JSON.stringify(features));
  execFileSync('python3', [SCRIPT, inPath, outPath, eps, maxp], { encoding: 'utf-8' });
  return JSON.parse(readFileSync(outPath, 'utf-8')) as {
    parts: number[][][]; source: string; epsilonDeg: number;
  };
}

const line = (coords: number[][]) => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }],
});

describe('обрезка по рамке Камчатки', () => {
  it('часть линии за рамкой отбрасывается, а не соединяется хордой', () => {
    // Линия из Охотского моря в рамку и дальше к Курилам. Если не резать,
    // вернётся прямая через море — та самая ложная диагональ на радаре.
    const out = run(line([[150, 55], [156, 53], [157, 52], [170, 52]]));
    const all = out.parts.flat();
    expect(all.every(([lng]) => lng >= 154 && lng <= 168)).toBe(true);
    expect(all.some(([lng]) => lng === 150 || lng === 170)).toBe(false);
  });

  it('разрыв внутри линии даёт ДВА куска, а не один сшитый', () => {
    const out = run(line([
      [156, 53], [156.5, 53], // в рамке
      [150, 53],              // вышли
      [158, 53], [158.5, 53], // вернулись
    ]));
    expect(out.parts.length).toBe(2);
  });
});

describe('упрощение огрубляет, но не выдумывает', () => {
  it('точки на прямой выбрасываются', () => {
    const out = run(line([[156, 53], [156.5, 53.0004], [157, 53]]), '0.01');
    expect(out.parts[0]).toEqual([[156, 53], [157, 53]]);
  });

  it('перегиб крупнее порога остаётся', () => {
    const out = run(line([[156, 53], [156.5, 53.5], [157, 53]]), '0.01');
    expect(out.parts[0].length).toBe(3);
  });

  it('потолок точек берётся ужесточением порога, а не обрезкой кусков', () => {
    // Обрезанный кусок — дыра в берегу; более грубая линия — тот же берег.
    const zig = Array.from({ length: 400 }, (_, i) => [156 + i * 0.01, 53 + (i % 2) * 0.05]);
    const out = run(line(zig), '0.001', '50');
    expect(out.parts.flat().length).toBeLessThanOrEqual(50);
    expect(out.epsilonDeg).toBeGreaterThan(0.001);
  });
});

describe('происхождение данных зафиксировано', () => {
  it('источник назван в самом файле результата', () => {
    const out = run(line([[156, 53], [157, 53]]));
    expect(out.source).toMatch(/Natural Earth/);
  });

  it('конвейер запускается файлом-триггером: ручной dispatch интеграции закрыт', () => {
    const wf = read('.github/workflows/data-coastline.yml');
    expect(wf).toMatch(/\.github\/triggers\/coastline\.json/);
    expect(existsSync(join(ROOT, '.github/triggers/coastline.json'))).toBe(true);
  });

  it('результат приходит веткой, а не коммитом в main', () => {
    const wf = read('.github/workflows/data-coastline.yml');
    expect(wf).toMatch(/git checkout -b "\$BR"/);
    expect(wf).not.toMatch(/git push origin main/);
  });
});
