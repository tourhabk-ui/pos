/**
 * CRM 2г-2: роуты, которые искали кабинет по user_id владельца, переведены на
 * общий резолвер (operatorAccess) — менеджер команды работает в них от
 * кабинета владельца, а деньги и цены — по правилу команды.
 *
 *   - AI-помощник: сводка и брони — команде; выручка — только владельцу;
 *     черновик тура с ценой — по праву can_edit_prices; «не смогли
 *     проверить» — честный ответ о сбое, а не «профиль не найден»;
 *   - аналитика (выручка) — только владельцу; без профиля 404, а не нули;
 *   - подборки — кабинет команды; отказ резолвера — ответ с причиной, а не
 *     пустой список.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const operatorAccess = vi.fn();
const query = vi.fn();
const requireAuth = vi.fn();
const requireOperator = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a), connect: vi.fn() } }));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...a: unknown[]) => requireAuth(...a),
  requireOperator: (...a: unknown[]) => requireOperator(...a),
}));
vi.mock('@/lib/operators/team-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operators/team-access')>()),
  operatorAccess: (...a: unknown[]) => operatorAccess(...a),
}));

const { OperatorAgency } = await import('@/lib/agents/agencies/operator-agency');
const analytics = await import('@/app/api/operator/analytics/route');
const selections = await import('@/app/api/hub/selections/route');

const CABINET = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000u1'.replace('u1', 'a1');
const owner = { kind: 'owner', partnerId: CABINET };
const manager = (can_edit_prices = false) => ({
  kind: 'manager', partnerId: CABINET, memberId: 'm1', perms: { can_edit_prices, can_cancel_bookings: false },
});
const ctx = {
  user: { userId: USER, role: 'operator' },
  task: {},
  platform: { routesCount: 0, activeOperators: 0, toursCount: 0 },
  execution: { agentName: 't', startedAt: new Date() },
} as unknown as Parameters<InstanceType<typeof OperatorAgency>['getRevenue']>[0];

beforeEach(() => {
  operatorAccess.mockReset();
  query.mockReset();
  requireAuth.mockReset();
  requireOperator.mockReset();
  requireOperator.mockResolvedValue({ userId: USER, role: 'operator', email: 'x@example.test' });
  requireAuth.mockResolvedValue({ userId: USER, role: 'operator', email: 'x@example.test' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('AI-помощник оператора: кабинет и права команды', () => {
  it('выручку видит владелец; менеджеру — отказ без похода в базу', async () => {
    operatorAccess.mockResolvedValueOnce(manager(true));
    const denied = await new OperatorAgency().getRevenue(ctx);
    expect(denied.response).toMatch(/Выручку видит владелец кабинета/);
    expect(query).not.toHaveBeenCalled();

    operatorAccess.mockResolvedValueOnce(owner);
    query.mockResolvedValueOnce({ rows: [{ revenue_7d: '12000', revenue_30d: '30000', bookings_7d: '1', bookings_30d: '3' }] });
    const ok = await new OperatorAgency().getRevenue(ctx);
    expect(ok.response).toMatch(/Ваша выручка/);
    expect(query.mock.calls[0][1]).toEqual([CABINET]);
  });

  it('черновик тура с ценой — по праву цен', async () => {
    operatorAccess.mockResolvedValueOnce(manager(false));
    const denied = await new OperatorAgency().createTour(ctx, 'Создай тур «Рыбалка» за 15000');
    expect(denied.response).toMatch(/разрешил цены/);
    expect(query).not.toHaveBeenCalled();
  });

  it('сводка туров — команде, от кабинета владельца', async () => {
    operatorAccess.mockResolvedValueOnce(manager(false));
    query.mockResolvedValueOnce({ rows: [] });
    await new OperatorAgency().getToursSummary(ctx);
    expect(query.mock.calls[0][1]).toEqual([CABINET]);
  });

  it('«не смогли проверить» — ответ о сбое, снятый — «закрыл доступ»', async () => {
    operatorAccess.mockResolvedValueOnce({ kind: 'unavailable', reason: 'sqlstate 57P01' });
    expect((await new OperatorAgency().getToursSummary(ctx)).response).toMatch(/Не удалось проверить доступ/);
    operatorAccess.mockResolvedValueOnce({ kind: 'none', reason: 'revoked' });
    expect((await new OperatorAgency().getToursSummary(ctx)).response).toMatch(/закрыл вам доступ/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('аналитика: деньги — только владельцу', () => {
  const req = () => new NextRequest('http://localhost/api/operator/analytics?period=30');
  // Гард requireOperatorOwner зовёт резолвер изнутри модуля — строку доступа
  // ему отдаёт мок базы, как боевой ACCESS_SQL.
  const accessRow = (r: Record<string, unknown>) => ({ rows: [{
    own_partner_id: null, member_partner_id: null, member_id: null,
    can_edit_prices: null, can_cancel_bookings: null, was_revoked: false, ...r,
  }] });

  it('менеджеру 403 «только владелец», запросов выручки нет', async () => {
    query.mockResolvedValueOnce(accessRow({ member_partner_id: CABINET, member_id: 'm1', can_edit_prices: true, can_cancel_bookings: false }));
    const res = await analytics.GET(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/владелец кабинета/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('без профиля — 404, а не «выручка ноль»', async () => {
    query.mockResolvedValueOnce(accessRow({}));
    const res = await analytics.GET(req());
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/totalRevenue/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('подборки: кабинет команды', () => {
  const get = () => selections.GET(new NextRequest('http://localhost/api/hub/selections'));

  it('менеджер видит подборки кабинета владельца', async () => {
    operatorAccess.mockResolvedValueOnce(manager(false));
    query.mockResolvedValueOnce({ rows: [{ id: 's1' }] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual([false, CABINET]);
  });

  it('без профиля — 404 с причиной, «не смогли проверить» — 503; не пустой список', async () => {
    operatorAccess.mockResolvedValueOnce({ kind: 'none', reason: 'no_profile' });
    expect((await get()).status).toBe(404);
    operatorAccess.mockResolvedValueOnce({ kind: 'unavailable', reason: 'sqlstate 57P01' });
    expect((await get()).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });

  it('администратор видит все, кабинет не ищется', async () => {
    requireAuth.mockResolvedValueOnce({ userId: USER, role: 'admin', email: 'a@example.test' });
    query.mockResolvedValueOnce({ rows: [] });
    expect((await get()).status).toBe(200);
    expect(operatorAccess).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]).toEqual([true, null]);
  });

  it('гард входа не пустил — его ответ', async () => {
    requireAuth.mockResolvedValueOnce(NextResponse.json({ error: 'Не авторизован' }, { status: 401 }));
    expect((await get()).status).toBe(401);
  });
});
