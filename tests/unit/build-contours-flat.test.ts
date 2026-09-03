/**
 * Сторож: «ноль горизонталей» — два разных факта, не один отказ.
 *
 * 03.09, прогон 97 (клетка cell-53n155e, юго-западное побережье): рельеф
 * собрался (max 57 м), а горизонтали упали с «НИ ОДНОЙ горизонтали не
 * построено», хотя земля не соврала — просто первая ступень (MIN_ELEVATION
 * = 100 м) выше всей клетки. До правки код не различал «трассировка
 * сломалась» и «рельеф генетически ниже первой линии» (§4.0): оба давали
 * одинаковый exit 1 и роняли всю сборку клетки.
 *
 * Гористый район никогда не даёт hmax < MIN_ELEVATION; низкий прибрежный —
 * даёт честно. Только эта ветка стала мягкой; «мозаика утверждает рельеф
 * выше первой ступени, а линий нет» остаётся отказом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PY = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_contours.py'), 'utf-8');

describe('build_contours.py: плоский рельеф ниже первой горизонтали — не сбой', () => {
  it('различает hmax < MIN_ELEVATION (честная плоскость) от противоречия (отказ)', () => {
    const at = PY.indexOf('if not features:');
    expect(at, 'ветка «нет линий» не найдена').toBeGreaterThan(0);
    const body = PY.slice(at, at + 1400);
    expect(body).toContain('if hmax < MIN_ELEVATION:');
    expect(body).toMatch(/рельеф ниже первой горизонтали[\s\S]*это не сбой/);
    // Отказ остаётся: рельеф заявлен выше ступени, а линий всё равно нет.
    expect(body).toMatch(/else:\s*\n\s*print\('НИ ОДНОЙ горизонтали не построено — прекращаю', file=sys\.stderr\)\s*\n\s*return 1/);
  });

  it('честная ветка не возвращает 1 — сборка клетки продолжается с пустыми файлами', () => {
    const at = PY.indexOf('if hmax < MIN_ELEVATION:');
    const elseAt = PY.indexOf('else:', at);
    expect(elseAt, 'ветка else не найдена').toBeGreaterThan(at);
    const ifBranch = PY.slice(at, elseAt);
    expect(ifBranch).not.toMatch(/return 1/);
  });
});
