/**
 * Дверь брони на сайте пишет воронку (#2882) — вызовом роута с подложенными
 * модулями. Отказы до общего модуля (форма не прошла проверку, дата в
 * прошлом, гость без e-mail) и сбой сервера — шаг `booking_rejected` с кодом
 * причины, id тура и заголовками посетителя; отказы по существу и саму заявку
 * пишет reserveBooking (здесь подложен), поэтому роут их не дублирует.
 * Заголовки запроса доходят до reserveBooking полем `visitor`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const recordMock = vi.fn(async () => 'ok' as const);
vi.mock('@/lib/funnel/record', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/funnel/record')>();
  return { ...real, recordFunnelEvent: (...a: unknown[]) => recordMock(...(a as [])) };
});
const reserveMock = vi.fn();
vi.mock('@/lib/bookings/reserve', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/bookings/reserve')>();
  return { ...real, reserveBooking: (...a: unknown[]) => reserveMock(...(a as [])) };
});
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: vi.fn(async () => null), createToken: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getTrustedClientIp: () => '203.0.113.9',
  getClientIp: () => '203.0.113.9',
}));
vi.mock('@/lib/bookings/notify-operator', () => ({ notifyOperatorOfNewBooking: vi.fn(async () => undefined) }));
vi.mock('@/lib/notifications/tourist-mail', () => ({ sendTouristMail: vi.fn(async () => undefined) }));
vi.mock('@/lib/telegram/booking-notify', () => ({ notifyTouristBookingCreated: vi.fn() }));
vi.mock('@/lib/bookings/auto-confirm', () => ({ autoConfirmIfAllowed: vi.fn(async () => 'new') }));
vi.mock('@/lib/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/config')>();
  return { ...real, getPublicBaseUrl: () => 'https://vedarai.ru' };
});

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari';
const post = (body: unknown) => new NextRequest('https://vedarai.ru/api/hub/bookings/create', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'user-agent': UA, cookie: 'vedar_self=1' },
});
const valid = {
  tour_id: 79, tourist_name: 'Анна', tourist_email: 'a@example.com', tourist_phone: '+79140001122',
  participants_count: 2, booking_date: '2031-07-10', pd_consent: true,
};
const VISITOR = { ip: '203.0.113.9', userAgent: UA, cookie: 'vedar_self=1' };

beforeEach(() => { recordMock.mockClear(); reserveMock.mockReset(); });

describe('дверь брони пишет отказы до общего модуля', () => {
  it('форма не прошла проверку — INVALID_FORM с id тура из тела, 400', async () => {
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const res = await POST(post({ ...valid, tourist_name: 'A' }));
    expect(res.status).toBe(400);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith({ step: 'booking_rejected', reason: 'INVALID_FORM', source: 'website', entityId: '79', visitor: VISITOR });
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('дата в прошлом — DATE_PAST, 422', async () => {
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const res = await POST(post({ ...valid, booking_date: '2020-01-01' }));
    expect(res.status).toBe(422);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ step: 'booking_rejected', reason: 'DATE_PAST', entityId: '79' }));
  });

  it('гость без e-mail — GUEST_EMAIL_REQUIRED, 400', async () => {
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const { tourist_email: _drop, ...noMail } = valid;
    void _drop;
    const res = await POST(post(noMail));
    expect(res.status).toBe(400);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ step: 'booking_rejected', reason: 'GUEST_EMAIL_REQUIRED', entityId: '79' }));
  });

  it('сбой сервера в общем модуле — SERVER_ERROR, 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reserveMock.mockRejectedValue(new Error('connection lost'));
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const res = await POST(post(valid));
    expect(res.status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ step: 'booking_rejected', reason: 'SERVER_ERROR', entityId: '79' }));
    vi.restoreAllMocks();
  });
});

describe('отказы по существу и заявку пишет общий модуль, роут не дублирует', () => {
  it('ReserveError из reserveBooking — 422, роут событий не пишет', async () => {
    const { ReserveError } = await import('@/lib/bookings/reserve');
    reserveMock.mockRejectedValue(new ReserveError('NO_SLOTS', 'Мест на эту дату не осталось.'));
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const res = await POST(post(valid));
    expect(res.status).toBe(422);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('заявка заведена — 200, роут событий не пишет, а заголовки посетителя дошли до reserveBooking', async () => {
    reserveMock.mockResolvedValue({
      bookingId: 5, accessToken: 'tok', totalPrice: 60000, operatorId: 'op', tourTitle: 'Толбачик', agentUserId: null, referralLinkId: null,
    });
    const { POST } = await import('@/app/api/hub/bookings/create/route');
    const res = await POST(post(valid));
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
    const input = reserveMock.mock.calls[0]![0] as { visitor?: unknown; createdVia: string; tourId: number };
    expect(input.createdVia).toBe('website');
    expect(input.tourId).toBe(79);
    expect(input.visitor).toEqual(VISITOR);
  });
});
