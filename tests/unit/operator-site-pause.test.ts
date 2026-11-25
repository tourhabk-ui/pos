/**
 * Пауза оператора (слово владельца 21.11.2026, #3487): блоки туров мест и
 * посадочных, а с 23.11 («Разберись с Местечком») — шлюз витрины туров и
 * список компаний /operators. Показ одного тура и страница самой компании по
 * прямой ссылке паузу не спрашивают (tourOpenByLinkSql) — их реестр держит
 * tests/unit/public-tour-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

import {
  OPERATOR_SITE_PAUSE_SLUGS,
  operatorPausedOnTourBlocks,
  operatorShownInTourBlocksSql,
  partnerOffStorefrontIdSql,
} from '@/lib/operators/site-pause';
import { publicTourSql, tourOpenByLinkSql } from '@/lib/tours/public-visibility';
import { queryOperators, queryOperatorLinks } from '@/lib/operators/list-query';
import { PLACE_TOURS_SQL, PLACE_TOUR_COUNTS_SQL } from '@/lib/places/place-tours';
import { LANDING_PUBLIC_TOURS_SQL } from '@/lib/landings/tours';

describe('пауза «Местечка» снята 25.11 (слово владельца «Сними паузу»)', () => {
  it('список паузы пуст: «Местечко» на витрине, как все', () => {
    expect(OPERATOR_SITE_PAUSE_SLUGS).toEqual([]);
    expect(operatorPausedOnTourBlocks('mestechko')).toBe(false);
  });

  it('при пустом списке условие — только статус: отклонённые и приостановленные уходят по-прежнему', () => {
    expect(operatorShownInTourBlocksSql('p')).toBe(
      "(p.status IS NULL OR p.status NOT IN ('suspended', 'rejected'))",
    );
  });
});

describe('operatorPausedOnTourBlocks — правило на переданном списке', () => {
  it('прячет slug из списка и не трогает других', () => {
    const paused = ['mestechko'];
    expect(operatorPausedOnTourBlocks('mestechko', paused)).toBe(true);
    expect(operatorPausedOnTourBlocks('volcanoesland', paused)).toBe(false);
    expect(operatorPausedOnTourBlocks(null, paused)).toBe(false);
    expect(operatorPausedOnTourBlocks('', paused)).toBe(false);
  });
});

describe('operatorShownInTourBlocksSql', () => {
  it('отсекает suspended, rejected и slug из списка паузы', () => {
    const sql = operatorShownInTourBlocksSql('p', ['mestechko']);
    expect(sql).toMatch(/p\.status NOT IN \('suspended', 'rejected'\)/);
    expect(sql).toMatch(/p\.slug <> ALL\(ARRAY\['mestechko'\]::text\[\]\)/);
  });

  it('отвергает недопустимый slug в списке', () => {
    expect(() => operatorShownInTourBlocksSql('p', ["x'; drop"])).toThrow(/недопустимый slug/);
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

describe('пауза — часть шлюза витрины туров (23.11)', () => {
  it('publicTourSql спрашивает паузу оператора тура, прямая ссылка — нет', () => {
    expect(publicTourSql('ot')).toContain(`AND NOT ${partnerOffStorefrontIdSql('ot.operator_id')})`);
    expect(publicTourSql('')).toContain(partnerOffStorefrontIdSql('operator_tours.operator_id'));
    expect(tourOpenByLinkSql('ot')).not.toContain('off_gate');
  });

  it('условие по id партнёра — то же, что у блоков мест, и отвергает чужую колонку', () => {
    const sql = partnerOffStorefrontIdSql('ot.operator_id');
    expect(sql).toContain('off_gate.id = ot.operator_id');
    expect(sql).toContain(`NOT (${operatorShownInTourBlocksSql('off_gate')})`);
    expect(() => partnerOffStorefrontIdSql('ot.operator_id; DROP')).toThrow(/недопустимая колонка/);
  });
});

describe('список компаний /operators не ставит компанию на паузе', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (/AS total/.test(sql)) return { rows: [{ total: '0' }] };
      return { rows: [] };
    });
  });

  it('каждый отбор карточек компаний в отправленном SQL несёт условие паузы', async () => {
    await queryOperators({ page: 1, limit: 12 });
    const partnerSelects = query.mock.calls.map((c) => String(c[0])).filter((q) => /FROM partners p\b/.test(q));
    expect(partnerSelects.length).toBeGreaterThan(0);
    for (const q of partnerSelects) expect(q).toContain(operatorShownInTourBlocksSql('p'));
  });

  it('ссылки на компании (бот) — тот же отбор', async () => {
    await queryOperatorLinks(10, []);
    const sent = query.mock.calls.map((c) => String(c[0])).filter((q) => /FROM partners p\b/.test(q));
    expect(sent.length).toBeGreaterThan(0);
    for (const q of sent) expect(q).toContain(operatorShownInTourBlocksSql('p'));
  });
});
