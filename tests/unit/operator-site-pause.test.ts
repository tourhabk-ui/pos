/**
 * Пауза оператора в блоках туров мест и посадочных (слово владельца 21.11.2026, #3487).
 */
import { describe, it, expect } from 'vitest';
import {
  OPERATOR_SITE_PAUSE_SLUGS,
  operatorPausedOnTourBlocks,
  operatorShownInTourBlocksSql,
} from '@/lib/operators/site-pause';
import { PLACE_TOURS_SQL, PLACE_TOUR_COUNTS_SQL } from '@/lib/places/place-tours';
import { LANDING_PUBLIC_TOURS_SQL } from '@/lib/landings/tours';

describe('operatorPausedOnTourBlocks', () => {
  it('прячет «Местечко» и не трогает других', () => {
    expect(OPERATOR_SITE_PAUSE_SLUGS).toContain('mestechko');
    expect(operatorPausedOnTourBlocks('mestechko')).toBe(true);
    expect(operatorPausedOnTourBlocks('volcanoesland')).toBe(false);
    expect(operatorPausedOnTourBlocks(null)).toBe(false);
    expect(operatorPausedOnTourBlocks('')).toBe(false);
  });
});

describe('operatorShownInTourBlocksSql', () => {
  it('отсекает suspended, rejected и slug из списка паузы', () => {
    const sql = operatorShownInTourBlocksSql('p');
    expect(sql).toMatch(/p\.status NOT IN \('suspended', 'rejected'\)/);
    expect(sql).toMatch(/p\.slug <> ALL\(ARRAY\['mestechko'\]::text\[\]\)/);
  });

  it('отвергает посторонний алиас', () => {
    expect(() => operatorShownInTourBlocksSql('p;drop')).toThrow(/недопустимый алиас/);
  });
});

describe('блоки мест и посадочных зовут тот же отбор', () => {
  const clause = operatorShownInTourBlocksSql('p');

  it('SQL страницы места, счёта плитки и блока посадочной содержит условие паузы', () => {
    expect(PLACE_TOURS_SQL).toContain(clause);
    expect(PLACE_TOUR_COUNTS_SQL).toContain(clause);
    expect(LANDING_PUBLIC_TOURS_SQL).toContain(clause);
  });
});
