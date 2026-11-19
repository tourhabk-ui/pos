/**
 * Не узнанный интерес называется, а не пропадает молча (#3394, п.2).
 * Сравнение с лидерами 15.11: «собачьи упряжки и термальные источники» давали
 * план с одними источниками; упряжки исчезали без слова, потому что «не
 * разобрал» звучало, только когда не узнано ничего.
 */
import { describe, it, expect } from 'vitest';
import { unparsedInterestParts, unparsedInterestsNote } from '@/lib/kuzmich/trip-plan-tool';

describe('куски интересов, которых планер не знает', () => {
  it('собачьи упряжки рядом с узнанными источниками', () => {
    expect(unparsedInterestParts('собачьи упряжки и термальные источники')).toEqual(['собачьи упряжки']);
    expect(unparsedInterestParts('вулканы, океан and медведи')).toEqual([]);
  });

  it('узнанное любым из двух словарей не называется', () => {
    expect(unparsedInterestParts('вулканы и восхождение')).toEqual([]);
    expect(unparsedInterestParts('рыбалка; хариус')).toEqual([]);
  });

  it('несколько не узнанных — все, пунктуация в конце снята', () => {
    expect(unparsedInterestParts('вулканы, собачьи упряжки, каякинг.')).toEqual(['собачьи упряжки', 'каякинг']);
  });

  it('строка плана — с кусками в кавычках и выходом в каталог; пусто — строки нет', () => {
    const note = unparsedInterestsNote(['собачьи упряжки']);
    expect(note).toContain('Не разобрал и в план не взял: «собачьи упряжки»');
    expect(note).toContain('/catalog');
    expect(unparsedInterestsNote([])).toBeNull();
  });
});
