/**
 * Счётчик спроса на жильё (решение владельца 29.09): связка целиком.
 *
 * Повод — вопрос «подключаться ли к TravelLine», который стоит 300 000 ₽ в
 * первый год. Ответ на него — число, и сторож держит, чтобы у числа были и
 * производители, и приёмник, и читатель, и исполнитель (§10.09): шаг в
 * словаре без маяка на поверхности — провод в никуда, перепись без прогона —
 * число, которое никто не спросит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FUNNEL_STEPS, EXECUTION_STEPS } from '@/lib/funnel/steps';
import {
  STAY_SEARCH_CHANNELS, STAY_SEARCH_OUTCOMES,
  staySearchEntity, parseStaySearchEntity, summarizeStaySearches,
} from '@/lib/stay/demand';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>());
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

describe('словарь', () => {
  it('шаги спроса на жильё — в едином словаре воронки', () => {
    expect(FUNNEL_STEPS).toContain('stay_search');
    expect(FUNNEL_STEPS).toContain('stay_booking_start');
  });

  it('в NSM «активированная поездка» не входят — её определение не расширяется молча', () => {
    expect(EXECUTION_STEPS).not.toContain('stay_search');
    expect(EXECUTION_STEPS).not.toContain('stay_booking_start');
  });

  it('entity_id укладывается в колонку приёмника (max 64)', () => {
    for (const c of STAY_SEARCH_CHANNELS) {
      for (const o of STAY_SEARCH_OUTCOMES) {
        const e = staySearchEntity(c, o);
        expect(e.length).toBeLessThanOrEqual(64);
        expect(parseStaySearchEntity(e)).toEqual({ channel: c, outcome: o });
      }
    }
  });

  it('у исхода есть «не смог» — три исхода, не два (§4.0)', () => {
    expect(STAY_SEARCH_OUTCOMES).toContain('failed');
  });

  it('чужая строка не угадывается', () => {
    for (const bad of [null, '', 'web', 'web:ok', 'mail:found', 'web:found:x']) {
      expect(parseStaySearchEntity(bad)).toBeNull();
    }
  });
});

describe('раскладка поисков', () => {
  it('нулевые клетки присутствуют, чужие события считаются отдельно', () => {
    const r = summarizeStaySearches([
      { entity_id: 'web:found', searches: 3, visitors: 2 },
      { entity_id: 'web:empty', searches: 1, visitors: 1 },
      { entity_id: 'agent:empty', searches: 5, visitors: 0 },
      { entity_id: 'typo', searches: 2, visitors: 2 },
    ]);
    expect(r.searches.web).toEqual({ found: 3, empty: 1, failed: 0 });
    expect(r.searches.agent).toEqual({ found: 0, empty: 5, failed: 0 });
    expect(r.web_visitors).toBe(3);
    expect(r.unrecognized).toBe(2);
  });

  it('пустой вход — нули, а не отсутствие', () => {
    const r = summarizeStaySearches([]);
    expect(r.searches.web).toEqual({ found: 0, empty: 0, failed: 0 });
    expect(r.searches.agent).toEqual({ found: 0, empty: 0, failed: 0 });
  });
});

describe('производители на каждой поверхности', () => {
  it('каталог /accommodations шлёт stay_search только на поиск с условиями', () => {
    const src = read('app/accommodations/_AccommodationsClient.tsx');
    expect(src).toMatch(/funnelBeacon\('stay_search', staySearchEntity\('web', outcome\)\)/);
    expect(src).toMatch(/currentPage === 1 && isSearch\(currentFilters\)/);
    // Исход по умолчанию — «не смог»: неответ витрины не выдаётся за «пусто».
    expect(src).toMatch(/let outcome: StaySearchOutcome = 'failed'/);
  });

  it('форма брони жилья шлёт stay_booking_start один раз', () => {
    const src = read('components/booking/StayBookingForm.tsx');
    expect(src).toMatch(/funnelBeacon\('stay_booking_start', accommodationId\)/);
    expect(src).toMatch(/touchedRef/);
  });

  it('Кузьмич и MCP — через одну функцию поиска, и она пишет спрос', () => {
    const src = read('lib/kuzmich/accommodation-search.ts');
    expect(src).toMatch(/recordAgentStaySearch\('failed'\)/);
    expect(src).toMatch(/recordAgentStaySearch\(rows\.length > 0 \? 'found' : 'empty'\)/);
    // MCP не заводит свой поиск жилья — иначе его спрос прошёл бы мимо счётчика.
    expect(read('app/api/mcp/route.ts')).toMatch(/executeKuzmichTool\(name, validation\.args\)/);
  });
});

describe('читатель и исполнитель', () => {
  it('перепись читает оба шага и журнал MCP', () => {
    const src = read('app/api/cron/stay-demand-census/route.ts');
    expect(src).toMatch(/step = 'stay_search'/);
    expect(src).toMatch(/step = 'stay_booking_start'/);
    expect(src).toMatch(/tool = 'search_accommodations'/);
    // Витрина — тем же шлюзом модерации, что у каталога.
    expect(src).toMatch(/publicAccommodationSql\('a'\)/);
    // Ноль до заведения счётчика — «не считали», и ответ это говорит.
    expect(src).toMatch(/window_predates_counter/);
    // Только чтение.
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('перепись зовёт прогон funnel-census.yml', () => {
    expect(read('.github/workflows/funnel-census.yml')).toMatch(/\/api\/cron\/stay-demand-census/);
  });
});

describe('серверная запись агента', () => {
  beforeEach(() => { poolQueryMock.mockReset(); });

  it('пишет stay_search с каналом agent и без посетителя', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const { recordAgentStaySearch } = await import('@/lib/stay/demand-record');
    await recordAgentStaySearch('empty');
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO funnel_events \(step, entity_id, visitor_hash\) VALUES \('stay_search', \$1, NULL\)/);
    expect(params).toEqual(['agent:empty']);
  });

  it('отказ записи не бросается наружу, но и не молчит', async () => {
    poolQueryMock.mockImplementation(async () => {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordAgentStaySearch } = await import('@/lib/stay/demand-record');
    let threw: unknown = null;
    try { await recordAgentStaySearch('found'); } catch (e) { threw = e; }
    const logged = errSpy.mock.calls.flat().join(' ');
    errSpy.mockRestore();
    expect(threw).toBeNull();
    expect(logged).toMatch(/SQLSTATE=42P01/);
  });
});
