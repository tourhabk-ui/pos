/**
 * `lib/bookings/booking.service.ts` пишет в operator_bookings, не в bookings.
 *
 * ── Разбор 11.09 (#1814) ───────────────────────────────────────────────────
 *
 * SELECT в этом файле всегда читал `operator_bookings` (правильно). Каждый
 * из четырёх UPDATE (confirm/cancel/reschedule/complete) писал в `bookings` —
 * отдельную, несовместимую таблицу (`id uuid`, без `refund_amount`,
 * `cancelled_at`, `cancelled_by`; см. `tests/unit/compat-view-writes.test.ts`
 * — план миграции 132 сделать её VIEW не выполнился на проде). Запрос
 * отвергался на разборе (42703) внутри транзакции — подтверждение, отмена,
 * завершение и перенос брони не работали НИ РАЗУ, включая кнопки оператора в
 * Telegram-боте.
 *
 * `tests/unit/compat-view-writes.test.ts` держит общее правило (никто не
 * пишет в bookings/tours) статическим поиском по всему репозиторию. Этот файл
 * держит СПЕЦИФИКУ: что именно и как каждая из четырёх функций пишет —
 * реальные колонки operator_bookings, а не типоподобные имена из старой
 * bookings (tour_id/date/guests_count/status), и что отмена возвращает места
 * в той же транзакции (иначе фикс сам открыл бы #1816 заново).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

const queryMock = vi.fn();
const releaseMock = vi.fn().mockResolvedValue(0);

vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (cb: (client: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => queryMock(...a) }),
}));

vi.mock('@/lib/payments/slot-counter', () => ({
  releaseSlotsForCancelledBooking: (...args: unknown[]) => releaseMock(...args),
}));

vi.mock('@/lib/notifications/booking-notifications', () => ({
  notifyBookingConfirmed: vi.fn(),
  notifyBookingCancelled: vi.fn(),
}));

function selectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    status: 'confirmed',
    tour_id: '7',
    total_price: '10000',
    date: '2026-12-01',
    start_date: '2026-12-01',
    participants: 2,
    guests_count: 2,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    tour_name: 'Тур',
    user_id: 'u-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmBooking — пишет operator_bookings.booking_status', () => {
  it('UPDATE нацелен на operator_bookings, не на bookings', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'new' })] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT booking_logs
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'confirmed' })] }); // повторный SELECT

    const { confirmBooking } = await import('@/lib/bookings/booking.service');
    await confirmBooking('42', 'op-1');

    const updateCall = queryMock.mock.calls.find(([sql]) => /^\s*UPDATE/i.test(String(sql)));
    expect(updateCall).toBeDefined();
    const sql = String(updateCall![0]);
    expect(sql).toMatch(/UPDATE\s+operator_bookings/i);
    expect(sql).not.toMatch(/UPDATE\s+bookings\s/i);
    expect(sql).toMatch(/booking_status\s*=\s*'confirmed'/);
  });
});

describe('completeBooking — пишет operator_bookings.booking_status', () => {
  it('UPDATE нацелен на operator_bookings', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'confirmed' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'completed' })] });

    const { completeBooking } = await import('@/lib/bookings/booking.service');
    await completeBooking('42', 'op-1');

    const updateCall = queryMock.mock.calls.find(([sql]) => /^\s*UPDATE/i.test(String(sql)));
    const sql = String(updateCall![0]);
    expect(sql).toMatch(/UPDATE\s+operator_bookings/i);
    expect(sql).not.toMatch(/UPDATE\s+bookings\s/i);
    expect(sql).toMatch(/booking_status\s*=\s*'completed'/);
  });
});

describe('cancelBooking — пишет operator_bookings и возвращает места', () => {
  it('UPDATE нацелен на operator_bookings.booking_status/cancellation_reason/cancelled_at', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'confirmed' })] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE cancel
      .mockResolvedValueOnce({ rows: [] }) // INSERT booking_logs
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'cancelled' })] });

    const { cancelBooking } = await import('@/lib/bookings/booking.service');
    await cancelBooking('42', 'user-1', 'tourist', 'передумал');

    const updateCall = queryMock.mock.calls.find(([sql]) => /^\s*UPDATE/i.test(String(sql)));
    const sql = String(updateCall![0]);
    expect(sql).toMatch(/UPDATE\s+operator_bookings/i);
    expect(sql).not.toMatch(/UPDATE\s+bookings\s/i);
    expect(sql).toMatch(/booking_status\s*=\s*'cancelled'/);
    expect(sql).toMatch(/cancellation_reason/);
    expect(sql).not.toMatch(/refund_amount/); // колонки не существует в operator_bookings
    expect(sql).not.toMatch(/cancelled_by\s*=/); // колонки не существует
  });

  it('releaseSlotsForCancelledBooking вызывается В ТОЙ ЖЕ транзакции (иначе #1816 вернётся)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'confirmed' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'cancelled' })] });

    const { cancelBooking } = await import('@/lib/bookings/booking.service');
    await cancelBooking('42', 'user-1', 'tourist');

    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(expect.anything(), '42');
  });

  it('отменять уже отменённую или завершённую бронь нельзя — терминальный статус', async () => {
    queryMock.mockResolvedValueOnce({ rows: [selectRow({ status: 'cancelled' })] });

    const { cancelBooking } = await import('@/lib/bookings/booking.service');
    await expect(cancelBooking('42', 'user-1', 'tourist')).rejects.toThrow(/терминальном состоянии/);
  });
});

describe('rescheduleBooking — пишет реальные колонки operator_bookings', () => {
  it('UPDATE использует operator_tour_id/booking_date, а не tour_id/date из старой bookings', async () => {
    // role: 'admin' — ownsCurrent/ownsTarget (только для 'operator') пропускаются.
    queryMock
      .mockResolvedValueOnce({
        rows: [{ tour_id: '7', status: 'confirmed', participants: 2, guests_count: 2, total_price: '10000', payment_status: 'paid' }],
      }) // bookingResult
      .mockResolvedValueOnce({
        rows: [{ id: '9', operator_id: 'op-9', max_participants: 20, base_price: '5000', title: 'Новый тур', is_active: true }],
      }) // targetTourResult
      .mockResolvedValueOnce({ rows: [{ booked: '0' }] }) // bookedResult
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT booking_logs
      .mockResolvedValueOnce({ rows: [selectRow({ status: 'confirmed' })] }); // финальный SELECT

    const { rescheduleBooking } = await import('@/lib/bookings/booking.service');
    await rescheduleBooking('42', 'admin-1', 'admin', {
      targetTourId: '9',
      targetDate: '2026-12-15',
    });

    const updateCall = queryMock.mock.calls.find(([sql]) => /^\s*UPDATE/i.test(String(sql)));
    const sql = String(updateCall![0]);
    expect(sql).toMatch(/UPDATE\s+operator_bookings/i);
    expect(sql).not.toMatch(/UPDATE\s+bookings\s/i);
    expect(sql).toMatch(/operator_tour_id\s*=/);
    expect(sql).toMatch(/booking_date\s*=/);
    expect(sql).not.toMatch(/\bdate\s*=\s*\$/); // старое имя колонки bookings.date
    expect(sql).not.toMatch(/guests_count\s*=/); // старое имя колонки bookings.guests_count
  });
});
