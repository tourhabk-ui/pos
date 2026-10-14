// @vitest-environment node
/**
 * Перепись маршрутов без адреса по имени (route-slug-census, 14.10) — вызовом:
 * роут с подменённым пулом и классификация на граничных строках. Сам запрос
 * исполняет сторож на настоящем PostgreSQL
 * (tests/integration/route-slug-on-write.pg.test.ts); здесь — что роут делает
 * с ответом базы, его отказом и кто его зовёт.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;
const queries: Array<{ sql: string; params: unknown[] }> = [];
let answer: (sql: string) => Row[] | Error = () => [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const out = answer(sql);
      if (out instanceof Error) throw out;
      return { rows: out, rowCount: out.length };
    }),
  },
}));

import { GET } from '@/app/api/cron/route-slug-census/route';
import {
  ROUTE_RESERVED_SLUGS,
  ROUTE_SLUG_CENSUS_SQL,
  ROUTE_SLUG_SHADOWED_SQL,
  routeSlugHolder,
  type RouteSlugCensusRow,
} from '@/lib/routes/slug-census';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

function row(over: Partial<RouteSlugCensusRow> = {}): RouteSlugCensusRow {
  return {
    id: 'r-1', title: 'Вулкан Горелый', base: 'vulkan-gorelyj', empty_slug: false,
    created_at: new Date('2026-10-05T03:00:00Z'), activity_type: 'trekking', geometry_source: 'gpx',
    is_section: false,
    place_holder_id: null, place_holder_name: null, place_holder_visible: null, place_holder_merged_into: null,
    route_holder_id: null, route_holder_title: null, route_holder_visible: null, route_holder_merged_into: null,
    claimants: 1, marshrut_free: true, would_assign: null,
    ...over,
  };
}

function get(secret = 'cron-test') {
  return GET(new NextRequest('http://localhost/api/cron/route-slug-census', { headers: { Authorization: `Bearer ${secret}` } }));
}

beforeEach(() => {
  queries.length = 0;
  answer = () => [];
  vi.stubEnv('CRON_SECRET', 'cron-test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('классификация держателя адреса', () => {
  it('один исход на каждый случай', () => {
    expect(routeSlugHolder(row({ base: '' }))).toBe('empty_base');
    expect(routeSlugHolder(row({ base: 'medvedi', is_section: true }))).toBe('section');
    expect(routeSlugHolder(row({ place_holder_id: 'p', place_holder_visible: true }))).toBe('visible_place');
    expect(routeSlugHolder(row({ place_holder_id: 'p', place_holder_visible: false }))).toBe('hidden_place');
    expect(routeSlugHolder(row({ place_holder_id: 'p', place_holder_visible: true, place_holder_merged_into: 'p2' }))).toBe('merged_place');
    expect(routeSlugHolder(row({ route_holder_id: 'r-2', route_holder_visible: false, route_holder_merged_into: 'r-1' }))).toBe('merged_into_this');
    expect(routeSlugHolder(row({ route_holder_id: 'r-2', route_holder_visible: false, route_holder_merged_into: 'r-9' }))).toBe('merged_route');
    expect(routeSlugHolder(row({ route_holder_id: 'r-2', route_holder_visible: false }))).toBe('hidden_route');
    expect(routeSlugHolder(row({ route_holder_id: 'r-2', route_holder_visible: true }))).toBe('visible_route');
    expect(routeSlugHolder(row({ claimants: 2 }))).toBe('namesake');
    expect(routeSlugHolder(row())).toBe('free');
  });

  it('адрес держат и место, и маршрут — называется место: имя принадлежит месту (решение 29.09)', () => {
    expect(routeSlugHolder(row({
      place_holder_id: 'p', place_holder_visible: true, route_holder_id: 'r-2', route_holder_visible: true,
    }))).toBe('visible_place');
  });
});

describe('роут переписи', () => {
  it('401 без секрета — и ни одного запроса к базе', async () => {
    const res = await get('wrong');
    expect(res.status).toBe(401);
    expect(queries).toEqual([]);
  });

  it('держатели по именам, итог по исходам, would_assign и маршруты под адресом раздела', async () => {
    answer = (sql) => {
      if (sql === ROUTE_SLUG_CENSUS_SQL) {
        return [
          row({ id: 'a', title: 'Озеро Голубое', base: 'ozero-goluboe', claimants: 2 }),
          row({ id: 'b', title: 'Озеро Голубое', base: 'ozero-goluboe', claimants: 2 }),
          row({ id: 'c', title: 'Ксудач', base: 'ksudach', place_holder_id: 'p-ks', place_holder_name: 'Вулкан Ксудач', place_holder_visible: true }),
          row({ id: 'd', title: 'Новый', base: 'novyj', would_assign: 'novyj' }),
        ] as unknown as Row[];
      }
      if (sql === ROUTE_SLUG_SHADOWED_SQL) return [{ id: 'z', title: 'Рыбалка на Быстрой', slug: 'rybalka' }];
      return [];
    };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      missing_total: 4,
      by_holder: { namesake: 2, visible_place: 1, free: 1 },
      would_assign_total: 1,
      shadowed_by_section: [{ id: 'z', title: 'Рыбалка на Быстрой', slug: 'rybalka' }],
    });
    expect(body.items[2]).toMatchObject({
      title: 'Ксудач', holder: 'visible_place', marshrut_free: true,
      place_holder: { id: 'p-ks', name: 'Вулкан Ксудач', visible: true, merged_into: null },
      route_holder: null,
      created_at: '2026-10-05T03:00:00.000Z',
    });
    // Список разделов уходит в запрос параметром — тот же, что в правиле записи.
    expect(queries.map((q) => q.params)).toEqual([[[...ROUTE_RESERVED_SLUGS]], [[...ROUTE_RESERVED_SLUGS]]]);
  });

  it('отказ базы — третий исход с причиной, а не пустой список', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer = () => Object.assign(new Error('function route_slug_candidate(uuid, text) does not exist'), { code: '42883' });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: 'function route_slug_candidate(uuid, text) does not exist' });
    expect(spy).toHaveBeenCalledWith('[route-slug-census] перепись не выполнена:', { sqlstate: '42883', message: expect.any(String) });
  });
});

describe('запрос и учёт', () => {
  it('только чтение: в запросах нет записи', () => {
    for (const sql of [ROUTE_SLUG_CENSUS_SQL, ROUTE_SLUG_SHADOWED_SQL]) {
      expect(sql).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER|DROP)\b/i);
    }
  });

  it('объявлен ручным, ничего не пишущим, и только читает базу', () => {
    expect(MANUAL_ENDPOINTS['route-slug-census']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['route-slug-census']).toEqual(['db_read']);
  });

  it('адреса под /routes/, занятые не маршрутом, — все разделы и все статичные сегменты', () => {
    const segments = readdirSync(join(process.cwd(), 'app/routes'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[[(_]/.test(e.name))
      .map((e) => e.name);
    expect(segments.length).toBeGreaterThan(0);
    expect([...ROUTE_RESERVED_SLUGS].sort()).toEqual([...Object.keys(CATEGORY_PAGES), ...segments].sort());
  });
});
