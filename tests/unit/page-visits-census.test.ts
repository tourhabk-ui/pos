/**
 * Перепись просмотров страницы (21.11): только счётчики, фильтр «людей» тот
 * же, что у витрины, путь из запроса — только путь, и каждый замер —
 * настоящий SQL, исполняется на PostgreSQL в интеграционном прогоне.
 */
import { describe, it, expect, vi } from 'vitest';

const queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; }) },
}));

import { GET, cleanPath, MEASURES } from '@/app/api/cron/page-visits-census/route';
import { NextRequest } from 'next/server';

const req = (qs: string, auth = 'Bearer s') => new NextRequest(`https://vedarai.ru/api/cron/page-visits-census?${qs}`, { headers: { authorization: auth } });

describe('page-visits-census', () => {
  it('без секрета — 401', async () => {
    process.env.CRON_SECRET = 's';
    expect((await GET(req('path=/planning', 'Bearer x'))).status).toBe(401);
  });

  it('путь — только путь: параметры, пробелы и чужое отклоняются', () => {
    expect(cleanPath('/tools/equipment')).toBe('/tools/equipment');
    expect(cleanPath('/routes/[id]')).toBe('/routes/[id]');
    expect(cleanPath('/planning?mode=trail')).toBeNull();
    expect(cleanPath('planning')).toBeNull();
    expect(cleanPath("/x' OR 1=1")).toBeNull();
  });

  it('каждый замер идёт по пути и окну параметрами, фильтр людей — как у витрины', async () => {
    process.env.CRON_SECRET = 's';
    queries.length = 0;
    const res = await GET(req('path=/tools/equipment&path=/planning&days=30'));
    expect(res.status).toBe(200);
    const body = await res.json() as { pages: Array<{ path: string; failed: string[] }>; filter: string };
    expect(body.pages.map((p) => p.path)).toEqual(['/tools/equipment', '/planning']);
    expect(body.filter).toBe('is_bot = FALSE AND is_self = FALSE');
    expect(queries).toHaveLength(MEASURES.length * 2);
    for (const q of queries) expect(q.params[1]).toBe(30);
  });

  it('наружу ни хэшей, ни полных ссылок: выбираются только счётчики и хост источника', () => {
    for (const m of MEASURES) {
      const select = m.sql.slice(0, m.sql.indexOf('FROM'));
      expect(select, m.name).not.toMatch(/ip_hash\s+AS|visitor_hash\s+AS|SELECT\s+referrer|,\s*referrer\s*,/);
    }
  });

  it('пустой список путей — 400', async () => {
    process.env.CRON_SECRET = 's';
    expect((await GET(req('path=bad'))).status).toBe(400);
  });
});
