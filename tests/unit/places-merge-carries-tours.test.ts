/**
 * Слияние мест везёт туры к оставшемуся месту — в ОБЕИХ дверях слияния
 * (ревью 29.10). Хелпер carryTourMainPlace проверен на PostgreSQL
 * (public-tour-gate.pg), но его подключение — нет: убери вызов из двери, и
 * тур с главным местом-дублем молча уходит с карточки места. Здесь — вызов
 * самих обработчиков с подменённой транзакцией: в запросах есть перенос туров
 * с параметрами [keep, merge], в ответе — сколько туров переехало.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const sent = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);
const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/database', () => ({
  transaction: async <T>(fn: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>) => fn({
    query: async (sql: string, params: unknown[] = []) => {
      sent.push({ sql, params });
      if (/UPDATE operator_tours/.test(sql)) return { rows: [], rowCount: 2 };
      if (/SELECT id, name, ark_id, merged_into_id FROM places/.test(sql)) {
        return { rows: [{ id: params[0], name: 'Дубль', ark_id: null, merged_into_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: async () => ({ userId: 'admin-1', role: 'admin' }),
}));
vi.mock('@/lib/places/aliases', () => ({ recordAlias: vi.fn(async () => undefined), moveAliases: vi.fn(async () => undefined) }));

const KEEP = '11111111-1111-4111-8111-111111111111';
const DUP = '22222222-2222-4222-8222-222222222222';

const carried = () => sent.filter((q) => /UPDATE operator_tours\s+SET main_place_id = \$1/.test(q.sql));

beforeEach(() => { sent.length = 0; poolQuery.mockReset(); });

describe('слияние мест переносит главное место туров', () => {
  it('POST /api/admin/places/merge: туры дубля едут к оставшемуся, число — в ответе', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: KEEP, ark_id: null, merged_into_id: null }] });
    const { POST } = await import('@/app/api/admin/places/merge/route');
    const res = await POST(new NextRequest('http://x/api/admin/places/merge', {
      method: 'POST', body: JSON.stringify({ keepId: KEEP, mergeIds: [DUP] }),
    })) as NextResponse;
    expect(res.status).toBe(200);
    const body = await res.json() as { toursMoved: number };
    expect(body.toursMoved).toBe(2);
    expect(carried()).toHaveLength(1);
    expect(carried()[0].params).toEqual([KEEP, DUP]);
  });

  it('POST /api/cron/places-dedup (пороговый план, не сухой): перенос в каждой паре, tours_moved в ответе', async () => {
    process.env.CRON_SECRET = 'test-secret';
    poolQuery.mockResolvedValue({ rows: [{
      id1: KEEP, name1: 'Вулкан Горелый', ark1: null, visible1: true, has_photo1: true, has_safety1: false,
      id2: DUP, name2: 'Горелый вулкан', ark2: null, visible2: false, has_photo2: false, has_safety2: false,
      name_sim: 0.8, dist_m: 40,
    }] });
    const { POST } = await import('@/app/api/cron/places-dedup/route');
    const res = await POST(new NextRequest('http://x/api/cron/places-dedup', {
      method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: JSON.stringify({ dry_run: false }),
    })) as NextResponse;
    expect(res.status).toBe(200);
    const body = await res.json() as { merged: Array<{ tours_moved: number }> };
    expect(body.merged.map((m) => m.tours_moved)).toEqual([2]);
    expect(carried()).toHaveLength(1);
    expect(carried()[0].params).toEqual([KEEP, DUP]);
  });
});
