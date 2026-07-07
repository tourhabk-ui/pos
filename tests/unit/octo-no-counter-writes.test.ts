/**
 * tests/unit/octo-no-counter-writes.test.ts
 *
 * OCTO-канал (внешние реселлеры) был единственным живым писателем
 * унифицированного счётчика tour_availability.booked_slots помимо
 * payment-webhook: инкремент на НЕОПЛАЧЕННОМ холде смешивал семантику
 * «оплаченные участники» (#336) и грозил переполнением CHECK на смешанных
 * каналах. Контракт: createBooking/cancelBooking не выполняют UPDATE
 * счётчика; гейт createBooking и availability считают занятость из
 * operator_bookings (NOT IN cancelled/rejected).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => poolQueryMock(...args),
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => clientQueryMock(...args),
      release: () => {},
    }),
  },
}));

vi.mock('@/lib/octo/webhooks', () => ({
  notifyOctoWebhooks: vi.fn().mockResolvedValue(undefined),
}));

import { createBooking, checkAvailability, cancelBooking } from '@/lib/octo/service';

const BOOKING_DATA = {
  tourId: '7',
  optionId: 'opt-1',
  availabilityId: 'avail-1',
  bookingDate: '2026-08-01',
  adultCount: 2,
  childCount: 0,
  apiKeyId: 'key-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OCTO createBooking — счётчик не пишется', () => {
  function mockHappyPath(taken: number) {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('octo_uuid FROM operator_bookings')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [{ id: '7', base_price: 5000, title: 'Тур' }] });
      if (sql.includes('FROM tour_options')) return Promise.resolve({ rows: [{ id: 'opt-1', price_adult: 5000, price_child: 3500 }] });
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return Promise.resolve({ rows: [{ id: 'ta-1', available_slots: 10 }] });
      if (sql.includes('SUM(participants)')) return Promise.resolve({ rows: [{ taken: String(taken) }] });
      if (sql.includes('INSERT INTO operator_bookings')) {
        return Promise.resolve({ rows: [{ id: 'b-1', octo_uuid: 'uuid-1', booking_status: 'new', created_at: '2026-07-07' }] });
      }
      if (sql.includes('INSERT INTO octo_booking_log')) return Promise.resolve({ rows: [] });
      // getBookingByUuid и прочее
      return Promise.resolve({ rows: [] });
    });
    poolQueryMock.mockResolvedValue({ rows: [] });
  }

  it('холд создаётся БЕЗ UPDATE tour_availability (счётчик не инкрементится)', async () => {
    mockHappyPath(0);

    await createBooking(BOOKING_DATA);

    const counterWrites = clientQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE tour_availability'));
    expect(counterWrites).toHaveLength(0);
  });

  it('гейт считает занятость из operator_bookings: 9 занято из 10 → холд на 2 отклонён', async () => {
    mockHappyPath(9);

    const result = await createBooking(BOOKING_DATA);
    expect(result).toEqual({ error: 'AVAILABILITY_SOLD_OUT' });

    const occCall = clientQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('SUM(participants)')) as [string];
    expect(occCall[0]).toContain("NOT IN ('cancelled', 'rejected')");
  });
});

describe('OCTO checkAvailability — занятость из реальных броней', () => {
  it('booked_slots в строках availability — из LATERAL по operator_bookings', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [{ id: 'ta-1', date: '2026-08-01', available_slots: 10, booked_slots: 4, base_price_override: null, base_price: 5000 }],
    });

    const result = await checkAvailability('7', 'opt-1', '2026-08-01', '2026-08-05');
    expect(result.mode).toBe('calendar');

    const [sql] = poolQueryMock.mock.calls[0] as [string];
    expect(sql).toContain('FROM operator_bookings');
    expect(sql).toContain("NOT IN ('cancelled', 'rejected')");
    expect(sql).not.toContain('ta.booked_slots');
  });
});

describe('OCTO cancelBooking — счётчик не декрементится', () => {
  it('отмена меняет статус брони, но не трогает tour_availability', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE operator_bookings')) {
        return Promise.resolve({ rows: [{ id: 'b-1', octo_uuid: 'uuid-1', operator_tour_id: '7', booking_date: '2026-08-01', participants: 2 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    poolQueryMock.mockResolvedValue({ rows: [] });

    await cancelBooking('uuid-1', 'key-1');

    const counterWrites = clientQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE tour_availability'));
    expect(counterWrites).toHaveLength(0);
  });
});
