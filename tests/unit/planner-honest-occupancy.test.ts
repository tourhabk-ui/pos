/**
 * tests/unit/planner-honest-occupancy.test.ts
 *
 * Планировщик на честной занятости (продолжение унификации PR #335/#336):
 * fetchAvailabilityForTour и fetchZoneCapacity больше не верят счётчику
 * tour_availability.booked_slots (его пишет только payment-webhook —
 * неоплаченные брони невидимы). Занятость тура — LATERAL из
 * operator_bookings (статусы NOT IN cancelled/rejected, как у гейткипера)
 * с клампом по max_participants; занятость зоны — v_tour_daily_occupancy
 * (многодневный разворот). Фолбэк при ошибке БД — прежний тихий.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import {
  fetchAvailabilityForTour,
  fetchZoneCapacity,
} from '@/lib/services/planner-data-layer';

// Каждый тест — свежий cache-объект, чтобы cached() не мемоизировал между тестами
function freshCache() {
  return new Map() as unknown as Parameters<typeof fetchAvailabilityForTour>[3];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchAvailabilityForTour — занятость из operator_bookings', () => {
  it('SQL считает из броней (NOT IN cancelled/rejected), не из счётчика booked_slots', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [{ date: '2026-08-01', available_slots: 10, booked_slots: 4, remaining: 6, price_override: null }],
    });

    const slots = await fetchAvailabilityForTour('7', '2026-08-01', '2026-08-05', freshCache());

    expect(slots).toEqual([{
      date: '2026-08-01', availableSlots: 10, bookedSlots: 4, remaining: 6, priceOverride: null,
    }]);

    const [sql] = poolQueryMock.mock.calls[0] as [string];
    expect(sql).toContain('FROM operator_bookings');
    expect(sql).toContain("NOT IN ('cancelled', 'rejected')");
    // кламп по max_participants — как в /api/tours/[id]/slots
    expect(sql).toContain('max_participants');
    expect(sql).toContain('LEAST');
    // счётчик из tour_availability больше не читается
    expect(sql).not.toContain('ta.booked_slots');
    expect(sql).toContain('ta.deleted_at IS NULL');
  });

  it('ошибка БД → прежний тихий фолбэк []', async () => {
    poolQueryMock.mockRejectedValue(new Error('db down'));
    const slots = await fetchAvailabilityForTour('7', '2026-08-01', '2026-08-05', freshCache());
    expect(slots).toEqual([]);
  });
});

describe('fetchZoneCapacity — занятость зоны из v_tour_daily_occupancy', () => {
  it('utilizationPercent считается из реальных броней (VIEW), не из счётчика', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [{ tour_count: '3', total_slots: '100', total_booked: '85' }],
    });

    const cap = await fetchZoneCapacity(
      'avachinsky' as Parameters<typeof fetchZoneCapacity>[0],
      '2026-08-01', '2026-08-05', freshCache()
    );

    expect(cap).toEqual({ tourCount: 3, totalSlots: 100, totalBooked: 85, utilizationPercent: 85 });

    const [sql] = poolQueryMock.mock.calls[0] as [string];
    expect(sql).toContain('v_tour_daily_occupancy');
    expect(sql).not.toContain('booked_slots');
  });

  it('ошибка БД → прежний тихий фолбэк (нули)', async () => {
    poolQueryMock.mockRejectedValue(new Error('db down'));
    const cap = await fetchZoneCapacity(
      'avachinsky' as Parameters<typeof fetchZoneCapacity>[0],
      '2026-08-01', '2026-08-05', freshCache()
    );
    expect(cap).toEqual({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 });
  });
});
