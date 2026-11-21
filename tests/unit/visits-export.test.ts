/**
 * Журнал просмотров файлом (21.11, «для Сыщика»): только администратору,
 * без IP, User-Agent, хэшей и параметров адреса; CSV без формульной инъекции.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({ admin: true, rows: [] as Record<string, unknown>[], params: [] as unknown[] }));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => (state.admin ? { userId: 'a' } : NextResponse.json({ error: 'Forbidden' }, { status: 403 }))),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async (_sql: string, params: unknown[]) => { state.params = params; return { rows: state.rows }; }) },
}));

import { GET, EXPORT_SQL, HEADERS, MAX_ROWS } from '@/app/api/admin/analytics/visits-export/route';

const req = (qs = '') => new NextRequest(`https://vedarai.ru/api/admin/analytics/visits-export${qs}`);

describe('журнал просмотров файлом', () => {
  beforeEach(() => { state.admin = true; state.rows = []; });

  it('не администратору — отказ', async () => {
    state.admin = false;
    expect((await GET(req())).status).toBe(403);
  });

  it('окно по умолчанию 48 часов, не больше недели; потолок строк', async () => {
    await GET(req());
    expect(state.params).toEqual([48, MAX_ROWS + 1]);
    await GET(req('?hours=10000'));
    expect(state.params[0]).toBe(168);
  });

  it('в выборке нет IP, User-Agent, хэшей и полной ссылки источника; путь без параметров', () => {
    const select = EXPORT_SQL.slice(0, EXPORT_SQL.indexOf('FROM page_views'));
    expect(select).not.toMatch(/ip_hash|visitor_hash|user_agent|\breferrer\b(?! from)/);
    expect(select).toMatch(/split_part\(split_part\(path, '\?', 1\), '#', 1\) AS path/);
    expect(select).toMatch(/AS referrer_host/);
    expect(Object.keys(HEADERS)).not.toContain('ip_hash');
  });

  it('CSV: заголовки по-русски, формула в пути становится текстом, обрезка сказана заголовком', async () => {
    state.rows = [{ time_utc: '2026-11-21T00:00:00Z', path: '=HYPERLINK("x")', is_bot: false }];
    const res = await GET(req());
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('x-truncated')).toBe('false');
    const text = await res.text();
    expect(text).toContain('Время UTC;Время по Камчатке;Путь');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
