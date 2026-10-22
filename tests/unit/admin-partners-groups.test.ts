/**
 * Разделение «партнёры / потенциальные» в GET /api/admin/operators:
 * критерий — участие в потоке заявок (lib/partners/partner-groups),
 * а не происхождение карточки. Проверяется запросом: какой SQL уходит
 * в базу при каждой группе и что отдаётся в meta.group_counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { queryMock, lastMock } = vi.hoisted(() => ({ queryMock: vi.fn(), lastMock: vi.fn() }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin', role: 'admin' })) }));
vi.mock('@/lib/database', () => ({ query: queryMock }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ lastPartnerDeliveries: lastMock }));

import { GET } from '@/app/api/admin/operators/route';

const OPS = [{ id: 'op-1', company_name: 'Местечко Камчатка' }];
const sqls: string[] = [];

beforeEach(() => {
  queryMock.mockReset();
  lastMock.mockReset();
  sqls.length = 0;
  lastMock.mockResolvedValue(new Map());
  queryMock.mockImplementation(async (sql: string) => {
    sqls.push(sql);
    if (/AS partners/.test(sql)) return { rows: [{ partners: '3', potential: '129' }] };
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1' }] };
    return { rows: OPS };
  });
});

const req = (qs: string) => new NextRequest(`https://vedarai.ru/api/admin/operators?${qs}`);

describe('GET /api/admin/operators — группы партнёров', () => {
  it('potential: только profile_status=none без заявки', async () => {
    const res = await GET(req('status=all&group=potential'));
    expect(res.status).toBe(200);
    const listSql = sqls.find(s => /FROM partners p/.test(s) && /LIMIT/.test(s)) ?? '';
    expect(listSql).toMatch(/p\.profile_status = 'none' AND NOT EXISTS \(SELECT 1 FROM operator_applications/);
  });

  it('partners: вошли в поток — статус не none или есть заявка', async () => {
    const res = await GET(req('status=all&group=partners'));
    expect(res.status).toBe(200);
    const listSql = sqls.find(s => /FROM partners p/.test(s) && /LIMIT/.test(s)) ?? '';
    expect(listSql).toMatch(/p\.profile_status <> 'none' OR EXISTS \(SELECT 1 FROM operator_applications/);
  });

  it('без group прежнее поведение: группового условия в списке нет', async () => {
    const res = await GET(req('status=all'));
    expect(res.status).toBe(200);
    const listSql = sqls.find(s => /FROM partners p/.test(s) && /LIMIT/.test(s)) ?? '';
    expect(listSql).not.toMatch(/operator_applications oa_g/);
  });

  it('meta.group_counts отдаёт обе группы тем же критерием', async () => {
    const res = await GET(req('status=pending&group=partners'));
    const body = await res.json() as { meta: { group_counts: { partners: number; potential: number } } };
    expect(body.meta.group_counts).toEqual({ partners: 3, potential: 129 });
    const countsSql = sqls.find(s => /AS partners/.test(s)) ?? '';
    expect(countsSql).toMatch(/profile_status = 'none' AND NOT EXISTS/);
    expect(countsSql).toMatch(/profile_status <> 'none' OR EXISTS/);
  });
});
