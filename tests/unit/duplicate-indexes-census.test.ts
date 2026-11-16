/**
 * Дубли индексов (#3388 п.4, шаг 1): правило «какой из пары снимать» —
 * вызовом на граничных данных, роут переписи — вызовом с подменённой базой.
 * Сам запрос к каталогу судит настоящий PostgreSQL
 * (блок дублей индексов в tests/integration/schema-model.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import { keeperOf, planDuplicateDrops, type IndexInGroup } from '@/lib/db/duplicate-indexes';
import { GET as census } from '@/app/api/cron/duplicate-indexes-census/route';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const ix = (name: string, over: Partial<IndexInGroup> = {}): IndexInGroup => ({
  name, unique: false, primary: false, backs_constraint: false, def: `CREATE INDEX ${name} ON t (c)`, ...over,
});

describe('какой индекс пары остаётся', () => {
  it('индекс под ограничением остаётся, даже если имя короче', () => {
    expect(keeperOf([ix('idx_users_email_long_name'), ix('users_email_key', { unique: true, backs_constraint: true })]).name)
      .toBe('users_email_key');
  });

  it('без ограничений уникальный остаётся, обычный снимается', () => {
    expect(keeperOf([ix('idx_a_long_long_name'), ix('uq_a', { unique: true })]).name).toBe('uq_a');
  });

  it('два обычных — остаётся подробное имя, при равной длине первый по алфавиту', () => {
    expect(keeperOf([ix('idx_lt_user'), ix('idx_loyalty_transactions_user_id')]).name).toBe('idx_loyalty_transactions_user_id');
    expect(keeperOf([ix('idx_b_x'), ix('idx_a_x')]).name).toBe('idx_a_x');
  });

  it('ограничение на двух индексах группы — снимать нечего, группа названа с причиной', () => {
    const plan = planDuplicateDrops([{ table_name: 't', indexes: [
      ix('t_a_key', { unique: true, backs_constraint: true }),
      ix('t_a_key2', { unique: true, backs_constraint: true }),
    ] }]);
    expect(plan.drops).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toMatch(/ограничени/);
  });
});

describe('роут переписи', () => {
  beforeEach(() => { queryMock.mockReset(); process.env.CRON_SECRET = 'test-secret'; });
  const req = (s: string) => new NextRequest('https://vedarai.ru/api/cron/duplicate-indexes-census', { headers: { authorization: `Bearer ${s}` } });

  it('без секрета — 401, в базу не ходит', async () => {
    expect((await census(req('wrong'))).status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('ответ — группы и план, индекс под ограничением не попадает в снятие', async () => {
    queryMock.mockResolvedValue({ rows: [{ table_name: 'users', indexes: [
      ix('idx_users_email'), ix('users_email_key', { unique: true, backs_constraint: true }),
    ] }] });
    const body = await (await census(req('test-secret'))).json();
    expect(body).toMatchObject({ ok: true, groups_total: 1, drop_total: 1 });
    expect(body.drops).toEqual([{ table: 'users', keep: 'users_email_key', drop: ['idx_users_email'] }]);
  });

  it('запрос упал — 500 с SQLSTATE, а не «дублей нет»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    queryMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    const res = await census(req('test-secret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, sqlstate: '57014' });
  });

  it('объявлена ручной переписью только на чтение', () => {
    expect(MANUAL_ENDPOINTS['duplicate-indexes-census']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['duplicate-indexes-census']).toEqual(['db_read']);
  });
});
