/**
 * tests/unit/honesty-small-fixes.test.ts
 *
 * Мелкие фиксы честности данных:
 * 1. Агентский дашборд: период применяется к дате БРОНИ (b.created_at),
 *    а не к дате регистрации клиента — брони/выручка старых клиентов
 *    больше не выпадают из тоталов за «7/30/90 дней».
 * 2. guide-agency: запросы расписания/групп/заработка переписаны с
 *    несуществующих operator_tours.guide_id и operator_bookings.departure_id
 *    (всегда пусто) на реальную связь partners.guide_operator_id +
 *    operator_bookings.operator_tour_id/booking_date/participants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAgent: vi.fn().mockResolvedValue({ userId: 'u-agent', role: 'agent' }),
}));
vi.mock('@/lib/auth/agent-helpers', () => ({
  getAgentPartnerId: vi.fn().mockResolvedValue('agent-1'),
}));

import { GET as agentDashboard } from '@/app/api/agent/dashboard/route';
import { GuideAgency } from '@/lib/agents/agencies/guide-agency';
import type { AgentContext } from '@/lib/agents/context-hub';

function req(url: string): NextRequest {
  const r = new Request(url) as unknown as NextRequest;
  (r as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent/dashboard — период по дате брони', () => {
  it('фильтр периода стоит на JOIN броней, клиенты считаются отдельным CASE', async () => {
    queryMock.mockResolvedValue({ rows: [{}] });

    await agentDashboard(req('http://localhost/api/agent/dashboard?period=30'));

    const metricsCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('agent_clients')) as [string];
    expect(metricsCall).toBeTruthy();
    const [sql] = metricsCall;
    // период на бронях (в JOIN), не в WHERE по клиентам
    expect(sql).toMatch(/JOIN agent_bookings b[\s\S]*b\.created_at >= NOW\(\)/);
    expect(sql).not.toMatch(/WHERE[\s\S]*c\.created_at >= NOW\(\)/);
    // клиенты за период — CASE, семантика сохранена
    expect(sql).toContain('CASE WHEN c.created_at >= NOW()');
  });
});

describe('guide-agency — реальные колонки вместо мёртвых JOIN', () => {
  const ctx = { user: { userId: 'guide-user-1' } } as unknown as AgentContext;

  function mockGuideQueries(scheduleRows: unknown[]) {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('guide_operator_id')) {
        return Promise.resolve({ rows: [{ guide_operator_id: 'op-3' }] });
      }
      if (sql.includes('FROM operator_bookings')) {
        return Promise.resolve({ rows: scheduleRows });
      }
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('расписание: SQL по operator_tour_id/booking_date, без tour_departures и guide_id', async () => {
    mockGuideQueries([{
      booking_id: 'b-1', tour_title: 'Морская прогулка',
      start_date: '2026-08-01', end_date: null, booked_slots: 4, status: 'confirmed',
    }]);

    const agency = new GuideAgency();
    const result = await agency.run('guide_schedule', ctx, '');

    expect(result.response).toContain('Морская прогулка');
    expect(result.response).toContain('4 чел');

    const schedCall = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM operator_bookings')) as [string, unknown[]];
    const [sql, params] = schedCall;
    expect(sql).toContain('b.operator_tour_id');
    expect(sql).toContain('b.booking_date');
    expect(sql).not.toContain('tour_departures');
    expect(sql).not.toContain('guide_id');
    expect(sql).not.toContain('b.tour_id');
    expect(params).toEqual(['op-3']);
  });

  it('гид без привязки к оператору → честное сообщение, запрос броней не выполняется', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ guide_operator_id: null }] });

    const agency = new GuideAgency();
    const result = await agency.run('guide_schedule', ctx, '');

    expect(result.response).toContain('не прикреплены к оператору');
    expect(poolQueryMock.mock.calls.some(([sql]) =>
      String(sql).includes('FROM operator_bookings'))).toBe(false);
  });

  it('группы: SUM(participants) из реальных броней', async () => {
    mockGuideQueries([{ active_groups: '2', total_tourists: '9' }]);

    const agency = new GuideAgency();
    const result = await agency.run('guide_groups', ctx, '');

    expect(result.response).toContain('Групп: 2');
    expect(result.response).toContain('Туристов: 9');

    const call = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM operator_bookings')) as [string];
    expect(call[0]).toContain('SUM(b.participants)');
    expect(call[0]).not.toContain('tour_departures');
  });
});
