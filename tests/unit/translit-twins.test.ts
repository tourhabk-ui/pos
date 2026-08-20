/**
 * Транслит-сличение латинских заголовков с кириллическими тёзками.
 *
 * Сторож держит две черты: схема транслита совпадает с той, какой писал
 * скрейпер (примеры — прямо из живых данных пробы 100), и перепись
 * остаётся переписью — только читает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  translitRuToLat, isLatinOnlyTitle, latinTokens, translitTokens, twinMatch,
} from '@/lib/routes/translit-twins';

describe('схема транслита — как у скрейпера', () => {
  it('живые примеры пробы 100 сходятся буква в букву', () => {
    expect(translitRuToLat('бухта пионерская')).toBe('bukhta pionerskaya');
    expect(translitRuToLat('голубые озера')).toBe('golubye ozera');
    expect(translitRuToLat('камчатский камень')).toBe('kamchatskiy kamen');
    expect(translitRuToLat('водопад на ручье спокойный')).toBe('vodopad na ruche spokoynyy');
  });

  it('шипящие, мягкий знак и ё', () => {
    expect(translitRuToLat('снежный')).toBe('snezhnyy');
    expect(translitRuToLat('щука')).toBe('shchuka');
    expect(translitRuToLat('озёра')).toBe('ozera');
  });
});

describe('распознавание латинского заголовка', () => {
  it('целиком латинский — да, кириллица и смесь — нет', () => {
    expect(isLatinOnlyTitle('bukhta pionerskaya')).toBe(true);
    expect(isLatinOnlyTitle('Бухта Пионерская')).toBe(false);
    expect(isLatinOnlyTitle('SUP-маршрут Полуостров Завойко')).toBe(false);
  });
});

describe('родство заголовков', () => {
  it('точная семья при разном порядке слов', () => {
    expect(twinMatch('bukhta pionerskaya', 'Бухта Пионерская')).toBe('exact');
    expect(twinMatch('vodopad babiy kamen', 'Водопад Бабий камень')).toBe('exact');
  });

  it('латинское имя полнее — надмножество, не exact', () => {
    expect(twinMatch('vodopad snezhnyy bars na ruche spokoynyy', 'Водопад на ручье Спокойный'))
      .toBe('latin_superset');
  });

  it('не родня — null, даже при общем слове', () => {
    expect(twinMatch('bukhta pionerskaya', 'Бухта Жировая')).toBe(null);
    expect(twinMatch('golubye ozera', 'Озеро Толмачёва')).toBe(null);
  });

  it('токены сравниваются сортированными', () => {
    expect(latinTokens('pionerskaya bukhta')).toEqual(translitTokens('Бухта Пионерская'));
  });
});

describe('перепись остаётся переписью', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/cron/route-translit-census/route.ts'), 'utf-8');

  it('только чтение: ни INSERT, ни UPDATE, ни DELETE', () => {
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM/i);
  });

  it('считает только живое и не слитое', () => {
    expect(src).toContain('r.is_visible = true AND r.merged_into_id IS NULL');
  });
});
