/**
 * Запрос списка /operators — вызов на граничных данных (находка аудита 15.10
 * PAVEL-operators).
 *
 * Факты о турах и виды для кнопок считаются отдельными запросами, и их отказ
 * не роняет список: карточки рендерятся без строки фактов, кнопок нет, а в
 * логе — имя запроса и SQLSTATE (§4.0: «не смог» не выдаётся ни за «туров
 * нет», ни за молчание). Отказ основного запроса по-прежнему бросается —
 * роут и страница отвечают на него своим контрактом.
 *
 * Что SQL верен (перевозчик вне списка, живой тур — условие каталога),
 * проверяется на настоящем PostgreSQL: tests/integration/operators-list.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

import { queryOperators, OperatorsQuerySchema } from '@/lib/operators/list-query';

const ROW = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'mestechko', name: 'Местечко Камчатка', category: 'operator',
  short_description: null, hero_image: null, rating: '0', review_count: '0', is_verified: false,
};
const NOLIVE = { ...ROW, id: '22222222-2222-4222-8222-222222222222', slug: 'nolive', name: 'Без туров' };

/** Отвечает по смыслу запроса; `fail` — имя запроса, который откажет. */
function db(fail: 'facts' | 'facets' | 'list' | null) {
  query.mockImplementation(async (sql: string) => {
    const err = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    if (/SELECT DISTINCT ot\.activity_type/.test(sql)) {
      if (fail === 'facets') throw err;
      return { rows: [{ activity_type: 'helicopter', operator_id: ROW.id }, { activity_type: 'jeep_safari', operator_id: ROW.id }] };
    }
    if (/ot\.operator_id = ANY/.test(sql)) {
      if (fail === 'facts') throw err;
      return { rows: [
        { operator_id: ROW.id, activity_type: 'helicopter', n: 5 },
        { operator_id: ROW.id, activity_type: 'jeep_safari', n: 8 },
      ] };
    }
    if (/COUNT\(\*\)::text AS total/.test(sql)) return { rows: [{ total: '2' }] };
    if (fail === 'list') throw err;
    return { rows: [ROW, NOLIVE] };
  });
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { query.mockReset(); errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); });

describe('queryOperators: факты и виды из данных', () => {
  it('факты у компании с турами, ноль — у компании без живых туров', async () => {
    db(null);
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.items.map((i) => i.slug)).toEqual(['mestechko', 'nolive']);
    expect(r.items[0].tourFacts).toEqual({
      total: 13,
      byActivity: [{ activity_type: 'jeep_safari', count: 8 }, { activity_type: 'helicopter', count: 5 }],
    });
    expect(r.items[1].tourFacts).toEqual({ total: 0, byActivity: [] });
    // Равное число компаний — по подписи: «Вертолёт» раньше «Джип-сафари».
    expect(r.activities).toEqual([{ activity_type: 'helicopter', count: 1 }, { activity_type: 'jeep_safari', count: 1 }]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('отказ запроса фактов — список есть, tourFacts null у всех, в логе имя и SQLSTATE', async () => {
    db('facts');
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.tourFacts === null)).toBe(true);
    expect(r.activities).not.toBeNull();
    const line = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toMatch(/operators-tour-facts/);
    expect(line).toMatch(/42P01/);
  });

  it('отказ запроса видов — список и факты есть, activities null, в логе имя и SQLSTATE', async () => {
    db('facets');
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.activities).toBeNull();
    expect(r.items[0].tourFacts?.total).toBe(13);
    const line = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toMatch(/operators-activity-facets/);
    expect(line).toMatch(/42P01/);
  });

  it('отказ основного запроса не глушится — бросается вызывающему', async () => {
    db('list');
    await expect(queryOperators({ page: 1, limit: 12 })).rejects.toThrow();
  });

  it('пустая страница — запроса фактов нет вовсе', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/COUNT\(DISTINCT/.test(sql)) return { rows: [] };
      if (/AS total/.test(sql)) return { rows: [{ total: '0' }] };
      if (/operator_id = ANY/.test(sql)) throw new Error('не должен вызываться');
      return { rows: [] };
    });
    const r = await queryOperators({ page: 1, limit: 12 });
    expect(r.items).toEqual([]);
    expect(r.activities).toEqual([]);
  });
});

describe('синонимы вида и порядок', () => {
  it('кнопки: «jeep» и «jeep_safari» — одна кнопка, компания считается один раз', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/SELECT DISTINCT ot\.activity_type/.test(sql)) {
        return { rows: [
          { activity_type: 'jeep', operator_id: ROW.id },
          { activity_type: 'jeep_safari', operator_id: ROW.id },
          { activity_type: 'jeep_safari', operator_id: NOLIVE.id },
        ] };
      }
      if (/ot\.operator_id = ANY/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\)::text AS total/.test(sql)) return { rows: [{ total: '2' }] };
      return { rows: [ROW, NOLIVE] };
    });
    const r = await queryOperators(OperatorsQuerySchema.parse({}));
    expect(r.activities).toEqual([{ activity_type: 'jeep_safari', count: 2 }]);
  });

  it('порядок — по имени, а не по хранимому рейтингу', async () => {
    db(null);
    await queryOperators(OperatorsQuerySchema.parse({}));
    const list = query.mock.calls.find((c) => /LIMIT/.test(String(c[0])));
    expect(String(list?.[0])).toMatch(/ORDER BY lower\(p\.name\), p\.id/);
    expect(String(list?.[0])).not.toMatch(/ORDER BY p\.rating/);
  });
});

describe('параметры адреса', () => {
  it('прежний ?category= отбрасывается схемой и не доходит до SQL', async () => {
    db(null);
    const filters = OperatorsQuerySchema.parse({ category: 'fishing', page: '1' });
    expect(filters).not.toHaveProperty('category');
    await queryOperators(filters);
    for (const call of query.mock.calls) expect(call[1] ?? []).not.toContain('fishing');
  });

  it('?activity= передаётся параметром, не текстом запроса', async () => {
    db(null);
    await queryOperators(OperatorsQuerySchema.parse({ activity: 'helicopter' }));
    const list = query.mock.calls.find((c) => /LIMIT/.test(String(c[0])));
    expect(list?.[1]).toContainEqual(['helicopter']);
    expect(String(list?.[0])).not.toContain('helicopter');
  });

  it('синоним вида в адресе (?activity=jeep) ищет все написания вида', async () => {
    db(null);
    await queryOperators(OperatorsQuerySchema.parse({ activity: 'jeep' }));
    const list = query.mock.calls.find((c) => /LIMIT/.test(String(c[0])));
    expect(list?.[1]).toContainEqual(['jeep_safari', 'jeep']);
  });

  it('вид не из алфавита ключей — отказ схемы, а не SQL', () => {
    expect(OperatorsQuerySchema.safeParse({ activity: "heli'; DROP" }).success).toBe(false);
  });
});
