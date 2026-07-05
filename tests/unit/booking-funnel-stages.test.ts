import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBookingFunnelStages } from '@/lib/services/booking-funnel-stages';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

/**
 * Три запроса сервиса идут в фиксированном порядке (Promise.all):
 *   0 — стадии по booking_status, 1 — предложение, 2 — спрос.
 * Хелпер отвечает по тексту SQL, чтобы не зависеть от порядка резолва.
 */
function mockBySql(map: {
  status: Array<{ booking_status: string; cnt: number }>;
  supply: { published_tours: number; operators_with_published_tours: number };
  demand: { tours_with_bookings: number; operators_with_bookings: number };
}) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('GROUP BY booking_status')) return Promise.resolve({ rows: map.status });
    if (sql.includes('published_tours')) return Promise.resolve({ rows: [map.supply] });
    if (sql.includes('tours_with_bookings')) return Promise.resolve({ rows: [map.demand] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

describe('getBookingFunnelStages (issue #273 — booking funnel stages)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('группирует по booking_status и суммирует totalBookings', async () => {
    mockBySql({
      status: [
        { booking_status: 'new', cnt: 3 },
        { booking_status: 'confirmed', cnt: 2 },
        { booking_status: 'cancelled', cnt: 1 },
      ],
      supply: { published_tours: 12, operators_with_published_tours: 5 },
      demand: { tours_with_bookings: 4, operators_with_bookings: 3 },
    });

    const r = await getBookingFunnelStages(7);

    expect(r.days).toBe(7);
    expect(r.byStatus).toEqual({ new: 3, confirmed: 2, cancelled: 1 });
    expect(r.totalBookings).toBe(6);
    expect(r.publishedTours).toBe(12);
    expect(r.operatorsWithPublishedTours).toBe(5);
    expect(r.toursWithBookings).toBe(4);
    expect(r.operatorsWithBookings).toBe(3);
  });

  it('при нулевых данных возвращает totalBookings=0 и пустой byStatus', async () => {
    mockBySql({
      status: [],
      supply: { published_tours: 8, operators_with_published_tours: 4 },
      demand: { tours_with_bookings: 0, operators_with_bookings: 0 },
    });

    const r = await getBookingFunnelStages(7);

    expect(r.totalBookings).toBe(0);
    expect(r.byStatus).toEqual({});
    // Предложение видно даже без спроса — отличаем 'нет спроса' от 'нет предложения'.
    expect(r.publishedTours).toBe(8);
  });

  it('группировка идёт по booking_status, а не по устаревшей status', async () => {
    mockBySql({
      status: [],
      supply: { published_tours: 0, operators_with_published_tours: 0 },
      demand: { tours_with_bookings: 0, operators_with_bookings: 0 },
    });

    await getBookingFunnelStages(7);

    const statusSql = mockQuery.mock.calls
      .map(c => c[0] as string)
      .find(sql => sql.includes('GROUP BY'));
    expect(statusSql).toBeDefined();
    expect(statusSql).toContain('GROUP BY booking_status');
    expect(statusSql).toContain('FROM operator_bookings');
    // не должно быть группировки/выборки по одиночной колонке status
    expect(statusSql).not.toMatch(/GROUP BY\s+status\b/);
  });

  it('передаёт окно дней параметризованно ($1), без конкатенации', async () => {
    mockBySql({
      status: [],
      supply: { published_tours: 0, operators_with_published_tours: 0 },
      demand: { tours_with_bookings: 0, operators_with_bookings: 0 },
    });

    await getBookingFunnelStages(30);

    const statusCall = mockQuery.mock.calls.find(c => (c[0] as string).includes('GROUP BY booking_status'));
    expect(statusCall?.[0]).toContain('make_interval(days => $1)');
    expect(statusCall?.[1]).toEqual([30]);
  });

  it('нормализует некорректное окно (<= 0) к 1 дню', async () => {
    mockBySql({
      status: [],
      supply: { published_tours: 0, operators_with_published_tours: 0 },
      demand: { tours_with_bookings: 0, operators_with_bookings: 0 },
    });

    const r = await getBookingFunnelStages(0);

    expect(r.days).toBe(1);
    const statusCall = mockQuery.mock.calls.find(c => (c[0] as string).includes('GROUP BY booking_status'));
    expect(statusCall?.[1]).toEqual([1]);
  });
});
