// @vitest-environment node
/**
 * Перепись alert-scope-census называет двойников ленты (#3275): запреты у
 * вулканов на проде записаны парами, и чтобы выбрать правку склейки, нужно
 * знать, откуда пришла каждая строка, когда и с тем ли описанием. Сторож —
 * вызовом роута с подменённой базой: поля доходят до ответа, счёт двойников —
 * по ним. Сам SQL проверен на PostgreSQL 16 при правке.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const rows = [
  { id: '1', alert_type: 'volcanic_eruption', title: 'Вулкан Шивелуч: не приближаться', severity: 2, has_coords: true, volcano_name: 'Шивелуч', volcano_anchored: true, volcano_scope: 'named', zones: ['northern'], places_covered: '3', farthest_km: '20.0', farthest_place: 'x',
    source_prefix: 'vk_mchs', external_day: '2026-11-12', created_at: '2026-11-12 06:00:00', expires_at: '2026-11-14 06:00:00', last_published_at: null, description_md5: 'aaaa0000', twins_same_title: 1, twins_same_description: 0 },
  { id: '2', alert_type: 'volcanic_eruption', title: 'Вулкан Шивелуч: не приближаться', severity: 2, has_coords: true, volcano_name: 'Шивелуч', volcano_anchored: true, volcano_scope: 'named', zones: ['northern'], places_covered: '3', farthest_km: '20.0', farthest_place: 'x',
    source_prefix: 'max_mchs', external_day: '2026-11-12', created_at: '2026-11-12 06:05:00', expires_at: '2026-11-14 06:05:00', last_published_at: null, description_md5: 'bbbb1111', twins_same_title: 1, twins_same_description: 0 },
  { id: '3', alert_type: 'road_closure', title: 'Проезд закрыт', severity: 1, has_coords: false, volcano_name: null, volcano_anchored: false, volcano_scope: 'named', zones: [], places_covered: '0', farthest_km: null, farthest_place: null,
    source_prefix: 'visitkamchatka', external_day: 'tg', created_at: '2026-11-12 06:10:00', expires_at: null, last_published_at: null, description_md5: 'cccc2222', twins_same_title: 0, twins_same_description: 0 },
];
const sqls: string[] = [];
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async (sql: string) => { sqls.push(sql); return { rows }; }) } }));

import { GET } from '@/app/api/cron/alert-scope-census/route';

describe('перепись ленты называет двойников', () => {
  it('у строки — источник, день, время записи и срок; счёт двойников по заголовку и по описанию', async () => {
    process.env.CRON_SECRET = 'census-secret-test';
    const res = await GET(new NextRequest('http://x/api/cron/alert-scope-census', { headers: { authorization: 'Bearer census-secret-test' } }));
    expect(res.status).toBe(200);
    const body = await res.json() as { alerts: Array<Record<string, unknown>>; title_twins: number; title_twins_same_description: number };
    expect(body.alerts[0]).toMatchObject({ source_prefix: 'vk_mchs', external_day: '2026-11-12', expires_at: '2026-11-14 06:00:00', description_md5: 'aaaa0000', twins_same_title: 1, twins_same_description: 0 });
    expect(body.alerts[1]).toMatchObject({ source_prefix: 'max_mchs' });
    expect(body.title_twins).toBe(2);
    expect(body.title_twins_same_description).toBe(0);
  });

  it('счёт двойников — только по действующим строкам того же типа и заголовка', () => {
    const sql = sqls[0] ?? '';
    expect(sql).toMatch(/tw\.id <> ea\.id AND tw\.title = ea\.title/);
    expect(sql).toMatch(/tw\.alert_type IS NOT DISTINCT FROM ea\.alert_type/);
    expect(sql).toMatch(/tw\.expires_at IS NULL OR tw\.expires_at >/);
  });

  it('без секрета — 401', async () => {
    const res = await GET(new NextRequest('http://x/api/cron/alert-scope-census'));
    expect(res.status).toBe(401);
  });
});
