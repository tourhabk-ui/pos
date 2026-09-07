/**
 * GET /api/cron/place-activity-census — перепись мест-активностей (§9).
 *
 * Только чтение, закрыт CRON_SECRET, судит именем через
 * lib/places/activity-name-judge.ts и ничего не скрывает/не удаляет сам —
 * решение по каждой находке за человеком (тот же принцип, что у
 * place-link-suggest, §4.1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { NextRequest } from 'next/server';
import { pool } from '@/lib/db-pool';
import { GET } from '@/app/api/cron/place-activity-census/route';

const queryMock = vi.mocked(pool.query);
const SRC = readFileSync(join(process.cwd(), 'app/api/cron/place-activity-census/route.ts'), 'utf-8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const req = (qs = '') => new NextRequest(`http://x/api/cron/place-activity-census${qs}`, {
  headers: { authorization: 'Bearer test-secret' },
});

beforeEach(() => {
  queryMock.mockReset();
  process.env.CRON_SECRET = 'test-secret';
});

describe('только чтение под секретом', () => {
  it('ничего не пишет', () => {
    expect(CODE).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });
  it('закрыт CRON_SECRET', () => {
    expect(CODE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
  it('неверный секрет — 401', async () => {
    const res = await GET(new NextRequest('http://x/api/cron/place-activity-census', {
      headers: { authorization: 'Bearer wrong' },
    }));
    expect(res.status).toBe(401);
  });
});

describe('перепись — только живые места, судит именем', () => {
  it('фильтрует видимые/не слитые и судит через judgePlaceActivityName', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: '1', name: 'Дикие озерки', location_type: 'hot_spring', lat: 53.1, lng: 158.1, description_head: null, route_titles: [] },
        { id: '2', name: 'Река Авача — рыбалка', location_type: 'river', lat: 53.2, lng: 158.2, description_head: null, route_titles: [] },
      ],
    } as never);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean; live_total: number; offenders_total: number;
      items: Array<{ id: string; name: string; matched: string[] }>;
    };
    expect(body.success).toBe(true);
    expect(body.live_total).toBe(2);
    expect(body.offenders_total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: '2', name: 'Река Авача — рыбалка', matched: ['рыбалка'] });

    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/p\.is_visible = true/);
    expect(sql).toMatch(/p\.merged_into_id IS NULL/);
  });

  it('нет нарушителей — честный пустой список, не выдумка', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: '1', name: 'Вулкан Горелый', location_type: 'volcano', lat: 52.5, lng: 157.3, description_head: null, route_titles: [] }],
    } as never);
    const res = await GET(req());
    const body = await res.json() as { offenders_total: number; items: unknown[] };
    expect(body.offenders_total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('окно offset/limit применяется к находкам', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: '1', name: 'Сплав по реке Быстрая', location_type: 'river', lat: 1, lng: 1, description_head: null, route_titles: [] },
        { id: '2', name: 'Восхождение на Авачинский', location_type: 'volcano', lat: 2, lng: 2, description_head: null, route_titles: [] },
      ],
    } as never);
    const res = await GET(req('?offset=1&limit=1'));
    const body = await res.json() as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('2');
  });

  it('отказ БД — 502 с честным сообщением, не пустой успех', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { code: '42P01' }));
    const res = await GET(req());
    expect(res.status).toBe(502);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });
});
