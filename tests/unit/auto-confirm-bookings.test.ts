/**
 * Автоподтверждение по выбору оператора (решение владельца 04.10: «мгновенная
 * оплата — да, по желанию оператора»). Правило 24.09 «платится подтверждённая
 * бронь» расширено, а не сломано: подтверждение ручное или автоматическое по
 * выбору оператора.
 *
 * Держится связка целиком: настройка есть где включить (кабинет), её читает
 * дверь брони, а «не смог проверить» — не подтверждение.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { queryMock, confirmMock } = vi.hoisted(() => ({ queryMock: vi.fn(), confirmMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/bookings/booking.service', () => ({ confirmBooking: (...a: unknown[]) => confirmMock(...a) }));

import { autoConfirmIfAllowed, AUTO_CONFIRM_COMMENT } from '@/lib/bookings/auto-confirm';

beforeEach(() => {
  queryMock.mockReset();
  confirmMock.mockReset().mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('autoConfirmIfAllowed', () => {
  it('оператор включил, дата в расписании — бронь подтверждается', async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: true }] });
    expect(await autoConfirmIfAllowed(42, 7, '2099-07-01')).toBe('confirmed');
    expect(confirmMock).toHaveBeenCalledWith('42', null, AUTO_CONFIRM_COMMENT);
  });

  it('настройка выключена или даты нет в расписании — ждёт оператора', async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: false }] });
    expect(await autoConfirmIfAllowed(42, 7, '2099-07-02')).toBe('new');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('база не ответила — не подтверждение, а ручное подтверждение и лог', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    expect(await autoConfirmIfAllowed(42, 7, '2099-07-01')).toBe('new');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('подтверждение упало — бронь остаётся new, отказ в логе', async () => {
    queryMock.mockResolvedValue({ rows: [{ allowed: true }] });
    confirmMock.mockRejectedValue(new Error('переход запрещён'));
    expect(await autoConfirmIfAllowed(42, 7, '2099-07-01')).toBe('new');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('связка: настройка — дверь брони — правило', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const RULE = code('lib/bookings/auto-confirm.ts');
  const CREATE = code('app/api/hub/bookings/create/route.ts');
  const SETTINGS = code('app/api/hub/operator/settings/auto-confirm/route.ts');

  it('правило требует и настройку, и дату из расписания оператора', () => {
    expect(RULE).toMatch(/os\.auto_confirm_bookings/);
    expect(RULE).toMatch(/FROM tour_availability ta[\s\S]*ta\.date = \$2::date[\s\S]*ta\.is_cancelled = false/);
  });

  it('дверь брони зовёт правило после reserveBooking и отдаёт статус', () => {
    expect(CREATE.indexOf('autoConfirmIfAllowed(')).toBeGreaterThan(CREATE.indexOf('reserveBooking('));
    expect(CREATE).toMatch(/booking_status: bookingStatus/);
  });

  it('настройку меняет только сам оператор, по своему аккаунту', () => {
    expect(SETTINGS).toMatch(/requireOperator\(request\)/);
    expect(SETTINGS).toMatch(/\[auth\.userId, parsed\.data\.enabled\]/);
    expect(readFileSync('app/hub/operator/bookings/_BookingsManagementClient.tsx', 'utf8')).toMatch(/<AutoConfirmToggle \/>/);
  });
});
