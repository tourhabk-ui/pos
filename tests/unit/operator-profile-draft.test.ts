/**
 * Черновик кабинета после «Войти как → Туроператор».
 * Админу партнёрская строка не заводится.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const team = vi.fn();
const ensure = vi.fn();
const requireOperator = vi.fn();
const query = vi.fn();
const reach = vi.fn();

vi.mock('@/lib/operators/team-access', () => ({
  requireOperatorTeam: (...a: unknown[]) => team(...a),
  requireOperatorOwner: vi.fn(),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: (...a: unknown[]) => requireOperator(...a),
}));
vi.mock('@/lib/auth/partner-profile', () => ({
  ensurePartnerForRole: (...a: unknown[]) => ensure(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reach(...a) }));

import { GET } from '@/app/api/hub/operator/profile/route';

const req = new Request('http://localhost/api/hub/operator/profile') as unknown as NextRequest;
const missing = NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 404 });

beforeEach(() => {
  team.mockReset();
  ensure.mockReset();
  requireOperator.mockReset();
  query.mockReset();
  reach.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/hub/operator/profile без строки партнёра', () => {
  it('админ не получает партнёра и слышит, как открыть кабинет', async () => {
    team.mockResolvedValueOnce(missing);
    requireOperator.mockResolvedValueOnce({ userId: 'admin-1', email: 'a@x.ru', role: 'admin' });
    const res = await GET(req);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'admin_no_company' });
    expect(ensure).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('роль operator — черновик, затем профиль с незавершённой настройкой', async () => {
    const ctx = {
      userId: 'op-1',
      email: 'o@x.ru',
      role: 'operator',
      partnerId: 'p-1',
      access: { kind: 'owner', partnerId: 'p-1' },
    };
    team.mockResolvedValueOnce(missing).mockResolvedValueOnce(ctx);
    requireOperator.mockResolvedValueOnce({ userId: 'op-1', email: 'o@x.ru', role: 'operator' });
    ensure.mockResolvedValueOnce('p-1');
    query.mockResolvedValueOnce({
      rows: [{ id: 'p-1', company_name: 'Черновик', onboarding_completed: false, payout_method: null }],
    });
    reach.mockResolvedValueOnce(null);
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(ensure).toHaveBeenCalledWith('op-1', 'operator');
    const body = await res.json() as { data: { onboarding_completed: boolean; company_name: string } };
    expect(body.data.onboarding_completed).toBe(false);
    expect(body.data.company_name).toBe('Черновик');
  });

  it('отказ базы при черновике — 503, а не «профиль не найден»', async () => {
    team.mockResolvedValueOnce(missing);
    requireOperator.mockResolvedValueOnce({ userId: 'op-1', email: 'o@x.ru', role: 'operator' });
    ensure.mockRejectedValueOnce(Object.assign(new Error('db'), { code: '08006' }));
    const res = await GET(req);
    expect(res.status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
});
