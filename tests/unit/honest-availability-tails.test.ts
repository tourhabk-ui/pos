/**
 * tests/unit/honest-availability-tails.test.ts
 *
 * Хвосты унификации вместимости (#335/#336): последние читатели счётчика
 * tour_availability.booked_slots («оплаченные», пишет только payment-webhook)
 * переведены на реальные брони. Контракты:
 * - agent/find-tours: свободные места из operator_bookings (NOT IN
 *   cancelled/rejected) с клампом по max_participants — агент больше не видит
 *   завышенную доступность (риск овербукинга);
 * - operator bookings-calendar: заполненность календаря оператора из
 *   SUM(participants) реальных броней;
 * - operator/calendar GET: booked_spots = SUM(participants) (люди), а не
 *   COUNT(*) (брони) — групповая бронь на 5 человек занимает 5 мест.
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
  requireRole: vi.fn().mockResolvedValue({ userId: 'u-agent', role: 'agent' }),
  requireAgent: vi.fn().mockResolvedValue({ userId: 'u-agent', role: 'agent' }),
  requireOperator: vi.fn().mockResolvedValue({ userId: 'u-op', role: 'operator' }),
}));

import { GET as findTours } from '@/app/api/agent/find-tours/route';
import { GET as bookingsCalendar } from '@/app/api/hub/operator/bookings-calendar/route';
import { GET as operatorCalendar } from '@/app/api/operator/calendar/route';

function req(url: string): NextRequest {
  const r = new Request(url) as unknown as NextRequest;
  (r as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent/find-tours — свободные места из реальных броней', () => {
  it('SQL считает из operator_bookings с клампом, счётчик не читается', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const res = await findTours(req('http://localhost/api/agent/find-tours?date_start=2026-08-01&date_end=2026-08-10&group_size=2'));
    expect(res.status).toBe(200);

    const sqlCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM operator_tours')) as [string];
    expect(sqlCall).toBeTruthy();
    const [sql] = sqlCall;
    expect(sql).toContain('FROM operator_bookings');
    expect(sql).toContain("NOT IN ('cancelled', 'rejected')");
    expect(sql).toContain('LEAST');
    expect(sql).toContain('max_participants');
    expect(sql).not.toContain('booked_slots');
    expect(sql).toContain('is_cancelled = FALSE');
  });
});

describe('operator bookings-calendar — заполненность из SUM(participants)', () => {
  it('availability_by_date считается из operator_bookings, не из счётчика', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'op-1' }] });
      if (sql.includes('FROM operator_bookings b')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM tour_availability')) {
        return Promise.resolve({ rows: [{
          date: '2026-08-01', available_slots: 10, booked_slots: 7,
          weather_status: 'ok', is_cancelled: false, tour_title: 'Тур', tour_id: '7',
        }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await bookingsCalendar(req('http://localhost/api/hub/operator/bookings-calendar?month=2026-08'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.availability_by_date['2026-08-01'][0].booked_slots).toBe(7);

    const availCall = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM tour_availability')) as [string];
    expect(availCall[0]).toContain('SUM(ob.participants)');
    expect(availCall[0]).toContain("NOT IN ('cancelled', 'rejected')");
    expect(availCall[0]).not.toContain('ta.booked_slots');
  });
});

describe('operator/calendar GET — booked_spots = люди, не брони', () => {
  it('подзапрос суммирует participants со статусами NOT IN cancelled/rejected', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'op-1' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await operatorCalendar(req('http://localhost/api/operator/calendar'));
    expect(res.status).toBe(200);

    const calCall = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('booked_spots')) as [string];
    expect(calCall).toBeTruthy();
    expect(calCall[0]).toContain('SUM(b.participants)');
    expect(calCall[0]).not.toContain('SELECT COUNT(*)');
    expect(calCall[0]).toContain("NOT IN ('cancelled', 'rejected')");
  });
});
