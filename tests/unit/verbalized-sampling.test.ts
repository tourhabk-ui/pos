/**
 * tests/unit/verbalized-sampling.test.ts
 *
 * Verbalized Sampling (arXiv:2510.01171) — парсинг распределения вариантов
 * и выбор наименее типичного качественного варианта.
 */

import { describe, it, expect } from 'vitest';
import {
  verbalizedInstruction, parseVerbalizedSamples, pickLeastTypical,
} from '@/lib/ai/verbalized-sampling';

describe('verbalizedInstruction', () => {
  it('просит N вариантов, вероятности и чистый JSON', () => {
    const s = verbalizedInstruction(3);
    expect(s).toMatch(/3/);
    expect(s).toMatch(/вероятност/i);
    expect(s).toMatch(/JSON/);
  });
});

describe('parseVerbalizedSamples', () => {
  it('парсит валидный JSON-массив', () => {
    const raw = '[{"probability":0.7,"text":"A"},{"probability":0.2,"text":"B"}]';
    expect(parseVerbalizedSamples(raw)).toEqual([
      { probability: 0.7, text: 'A' }, { probability: 0.2, text: 'B' },
    ]);
  });

  it('терпит ```json-ограждение и окружающий текст', () => {
    const raw = 'Вот варианты:\n```json\n[{"probability":0.5,"text":"X"}]\n```\nготово';
    expect(parseVerbalizedSamples(raw)).toEqual([{ probability: 0.5, text: 'X' }]);
  });

  it('вероятность строкой — приводится к числу', () => {
    expect(parseVerbalizedSamples('[{"probability":"0.3","text":"Y"}]'))
      .toEqual([{ probability: 0.3, text: 'Y' }]);
  });

  it('невалидный / не-массив / без text → []', () => {
    expect(parseVerbalizedSamples('не json вовсе')).toEqual([]);
    expect(parseVerbalizedSamples('{"probability":0.5,"text":"Z"}')).toEqual([]);
    expect(parseVerbalizedSamples('[{"probability":0.5}]')).toEqual([]);
    expect(parseVerbalizedSamples('')).toEqual([]);
  });
});

describe('pickLeastTypical', () => {
  const long = (c: string) => c.repeat(150); // >= minLen 100

  it('выбирает наименее вероятный (наименее шаблонный) среди валидных', () => {
    const picked = pickLeastTypical([
      { probability: 0.8, text: long('A') },
      { probability: 0.2, text: long('B') },
      { probability: 0.5, text: long('C') },
    ], 100);
    expect(picked).toBe(long('B'));
  });

  it('отсекает слишком короткие варианты', () => {
    const picked = pickLeastTypical([
      { probability: 0.1, text: 'коротко' },       // мал по длине — вырожденный
      { probability: 0.9, text: long('D') },
    ], 100);
    expect(picked).toBe(long('D'));
  });

  it('отсекает мусорные с вероятностью ниже порога', () => {
    const picked = pickLeastTypical([
      { probability: 0.0, text: long('E') },        // prob < floor
      { probability: 0.6, text: long('F') },
    ], 100);
    expect(picked).toBe(long('F'));
  });

  it('нет валидных → null (caller делает fallback)', () => {
    expect(pickLeastTypical([{ probability: 0.9, text: 'x' }], 100)).toBeNull();
    expect(pickLeastTypical([], 100)).toBeNull();
  });
});
