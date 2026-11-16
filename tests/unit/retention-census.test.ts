/**
 * Перепись сроков хранения (#3388, п. 2) — вызовом, на подставной базе.
 *
 * Что держится:
 *  - срок уходит параметром через make_interval, имя таблицы — только из списка;
 *  - три исхода у каждой таблицы: число, «нет таблицы» (42P01), «не смог»;
 *  - профиль без поля последней активности назван «посчитать нечем», а не
 *    подменён updated_at;
 *  - в ответе нет ничего, кроме чисел и дат;
 *  - роут закрыт CRON_SECRET.
 * На настоящем PostgreSQL каждая таблица и колонка списка проверяется в
 * tests/integration/schema-model.pg.test.ts (блок «перепись сроков хранения»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  RETENTION_TARGETS, TECH_LOG_DAYS, retentionCountSql, runRetentionCensus,
} from '@/lib/legal/retention-census';

const q = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: q.query } }));

beforeEach(() => { q.query.mockReset(); });

describe('правило переписи', () => {
  it('срок — параметром через make_interval, без склейки строкой', () => {
    const sql = retentionCountSql({ table: 'page_views', column: 'created_at' });
    expect(sql).toMatch(/make_interval\(days => \$1::int\)/);
    expect(sql).not.toMatch(/'\s*\|\|/);
    expect(sql).toMatch(/FROM page_views$/m);
  });

  it('чужое имя таблицы не проходит', () => {
    expect(() => retentionCountSql({ table: 'leads; DROP TABLE users', column: 'created_at' })).toThrow(/недопустимое имя/);
  });

  it('журналы — 90 дней, заявки от updated_at, брони от даты тура', () => {
    const by = (t: string) => RETENTION_TARGETS.find((x) => x.table === t)!;
    expect(by('page_views').days).toBe(TECH_LOG_DAYS);
    expect(by('leads')).toMatchObject({ column: 'updated_at', term: 'leads_3y' });
    expect(by('operator_bookings')).toMatchObject({ column: 'booking_date', term: 'bookings_5y' });
    expect(by('chat_sessions')).toMatchObject({ column: 'updated_at', term: 'chat_3y' });
    expect(RETENTION_TARGETS.find((x) => x.table === 'users'), 'профиль не судится по updated_at').toBeUndefined();
  });
});

describe('три исхода', () => {
  const targets = [
    { table: 'page_views', column: 'created_at', term: 'tech_logs_90d' as const, days: 90, pruned: null },
    { table: 'octo_webhook_log', column: 'created_at', term: 'tech_logs_90d' as const, days: 90, pruned: null },
    { table: 'leads', column: 'updated_at', term: 'leads_3y' as const, days: 1095, pruned: null },
  ];

  it('число, нет таблицы, не смог — порознь; срок передан параметром', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 120, over_term: 7, oldest: '2026-07-01' }] })
      .mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: '57014' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runRetentionCensus(query, targets);
    expect(out.rows[0]).toMatchObject({ table: 'page_views', state: 'ok', total: 120, over_term: 7, oldest: '2026-07-01' });
    expect(out.rows[1]).toMatchObject({ table: 'octo_webhook_log', state: 'no_table' });
    expect(out.rows[2]).toMatchObject({ table: 'leads', state: 'failed', reason: 'SQLSTATE 57014' });
    expect(query.mock.calls.map((c) => c[1])).toEqual([[90], [90], [1095]]);
    expect(out.over_term_tables.tech_logs_90d).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.unmeasurable.join(' ')).toMatch(/поля последней активности/);
  });
});

describe('роут', () => {
  it('без CRON_SECRET — 401, с ним — числа без строк данных', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    q.query.mockResolvedValue({ rows: [{ total: 3, over_term: 0, oldest: '2026-11-01' }] });
    const { GET } = await import('@/app/api/cron/retention-census/route');
    const denied = await GET(new NextRequest('https://vedarai.ru/api/cron/retention-census'));
    expect(denied.status).toBe(401);
    const ok = await GET(new NextRequest('https://vedarai.ru/api/cron/retention-census', { headers: { authorization: 'Bearer test-secret' } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.rows).toHaveLength(RETENTION_TARGETS.length);
    // Только числа, даты и служебные слова — ни одного значения из строк таблиц.
    for (const r of body.rows) expect(Object.keys(r).sort()).toEqual(['column', 'days', 'oldest', 'over_term', 'pruned', 'state', 'table', 'term', 'total']);
    vi.unstubAllEnvs();
  });
});
