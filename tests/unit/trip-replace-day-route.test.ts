// @vitest-environment node
/**
 * POST /api/trips/[id]/replace-day — дверь замены дня новым черновиком
 * (#3394, срез 2). Вызовом роута: только владельцу поездки, тело проверено,
 * поездка читается тем же запросом, что карточка, исходы правила — как есть,
 * «черновик не записался» — 503, отказ базы — 500 со словами и SQLSTATE в логе.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const r = vi.hoisted(() => ({
  user: 'u1' as string | null,
  query: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => (r.user
    ? { userId: r.user }
    : NextResponse.json({ success: false, error: 'Требуется вход' }, { status: 401 })),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => r.query(...a) } }));
vi.mock('@/lib/trips/trip-replace-day', async (orig) => ({
  ...(await orig<typeof import('@/lib/trips/trip-replace-day')>()),
  replaceTripDay: (...a: unknown[]) => r.replace(...a),
}));

import { POST } from '@/app/api/trips/[id]/replace-day/route';

const ID = '11111111-2222-4333-8444-555555555555';
const ROW = {
  id: ID, user_id: 'u1', title: 'Поездка', arrival_date: '2026-12-01', departure_date: '2026-12-04',
  activities: ['volcano'], days: [{ day: 1, zone: 'avachinsky', title: 'День' }],
  party: { adults: 2, children: [], budgetTier: 'comfort' }, updated_at: new Date(),
};

async function call(body: unknown, id = ID) {
  const res = await POST(
    new NextRequest(`http://x/api/trips/${id}/replace-day`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() as { success: boolean; error?: string; data?: { state: string } } };
}

beforeEach(() => {
  r.user = 'u1';
  r.query.mockReset();
  r.replace.mockReset();
  r.query.mockResolvedValue({ rows: [ROW] });
  r.replace.mockResolvedValue({ state: 'refused', reason: 'День 1 — день прилёта, его не заменяют.' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/trips/[id]/replace-day', () => {
  it('без входа — 401, база и правило не зовутся', async () => {
    r.user = null;
    expect((await call({ day: 2, interest: 'thermal' })).status).toBe(401);
    expect(r.query).not.toHaveBeenCalled();
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('неверный id — 404; тело не то — 400 словами; занятие не из списка — 400', async () => {
    expect((await call({ day: 2, interest: 'thermal' }, 'nope')).status).toBe(404);
    expect((await call('{')).status).toBe(400);
    const bad = await call({ day: 2, interest: 'skydiving' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Укажите день и занятие из списка');
    expect((await call({ day: 0, interest: 'thermal' })).status).toBe(400);
    expect(r.query).not.toHaveBeenCalled();
  });

  it('чужая или удалённая поездка — 404 по условию владельца, правило не зовётся', async () => {
    r.query.mockResolvedValue({ rows: [] });
    expect((await call({ day: 2, interest: 'thermal' })).status).toBe(404);
    const [sql, params] = r.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/user_id = \$2/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(params).toEqual([ID, 'u1']);
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('своя поездка — правилу уходят её поля и выбор человека; отказ правила — 200 с причиной', async () => {
    const res = await call({ day: 2, interest: 'thermal' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ state: 'refused', reason: 'День 1 — день прилёта, его не заменяют.' });
    const [tripArg, day, interest] = r.replace.mock.calls[0] as [Record<string, unknown>, number, string];
    expect(tripArg).toMatchObject({ arrival_date: '2026-12-01', departure_date: '2026-12-04', activities: ['volcano'], party: ROW.party });
    expect(day).toBe(2);
    expect(interest).toBe('thermal');
  });

  it('черновик не записался — 503 со словами правила; отказ базы — 500 и SQLSTATE в логе', async () => {
    r.replace.mockResolvedValue({ state: 'failed', reason: 'Замена подобрана, но черновик не записался — попробуйте ещё раз.' });
    const unsaved = await call({ day: 2, interest: 'thermal' });
    expect(unsaved.status).toBe(503);
    expect(unsaved.body.data?.state).toBe('failed');

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.query.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    const bad = await call({ day: 2, interest: 'thermal' });
    expect(bad.status).toBe(500);
    expect(bad.body.error).toBe('Подобрать замену сейчас не получилось — попробуйте чуть позже');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[trips/replace-day]'), '57014', 'timeout');
  });
});
