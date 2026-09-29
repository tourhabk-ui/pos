/**
 * tests/unit/planner-honest-occupancy.test.ts
 *
 * Планировщик на честной занятости (продолжение унификации PR #335/#336):
 * fetchAvailabilityForTour и fetchZoneCapacity больше не верят счётчику
 * tour_availability.booked_slots (его пишет только payment-webhook —
 * неоплаченные брони невидимы). Занятость тура — LATERAL из
 * operator_bookings (статусы NOT IN cancelled/rejected, как у гейткипера)
 * с клампом по max_participants; занятость зоны — v_tour_daily_occupancy
 * (многодневный разворот).
 *
 * Фолбэк при ошибке БД БОЛЬШЕ НЕ ТИХИЙ (27.09). Он был «прежним тихим» по
 * наследству: занятость зоны штрафовала оценку, и нули при отказе означали
 * лишь «штрафа не будет». С 27.09 это число идёт НА ЭКРАН меткой загрузки
 * зоны, и ноль там читается как «свободно» — обещание, которого никто не
 * проверял. Теперь отказ даёт `utilizationPercent: null` и строку в лог
 * (§4.0: «не смог» не равно «хорошо»).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import {
  fetchAvailabilityForTour,
  fetchZoneCapacity,
} from '@/lib/planner/data';

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

  it('ошибка БД → отказ, а не «мест нет» (аудит MCP 29.09)', async () => {
    // Раньше здесь был тихий фолбэк [] — и агент говорил человеку «свободных
    // дат нет», когда база просто не ответила.
    poolQueryMock.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchAvailabilityForTour('7', '2026-08-01', '2026-08-05', freshCache()))
      .rejects.toThrow(/Не удалось проверить занятость/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
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

  it('ошибка БД → занятость null и строка в лог, а не нулевая занятость', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockRejectedValue(new Error('db down'));
    const cap = await fetchZoneCapacity(
      'avachinsky' as Parameters<typeof fetchZoneCapacity>[0],
      '2026-08-01', '2026-08-05', freshCache()
    );
    expect(cap).toEqual({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: null });
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain('занятость зоны');
    spy.mockRestore();
  });

  it('нет слотов на даты → тоже null: делить не на что', async () => {
    // Ноль значит «свободно». «Слотов нет вовсе» — другое состояние, и
    // выдавать его за свободу нельзя: метка на экране обещает свободные места.
    poolQueryMock.mockResolvedValue({ rows: [{ tour_count: '0', total_slots: '0', total_booked: '0' }] });
    const cap = await fetchZoneCapacity(
      'avachinsky' as Parameters<typeof fetchZoneCapacity>[0],
      '2026-08-01', '2026-08-05', freshCache()
    );
    expect(cap.utilizationPercent).toBeNull();
  });

  it('слоты есть → честный процент', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ tour_count: '2', total_slots: '10', total_booked: '4' }] });
    const cap = await fetchZoneCapacity(
      'avachinsky' as Parameters<typeof fetchZoneCapacity>[0],
      '2026-08-01', '2026-08-05', freshCache()
    );
    expect(cap.utilizationPercent).toBe(40);
  });
});
