/**
 * POST /api/routes/build (владелец 28.08, PR 5B-1) — сервер как единственная
 * дверь до маршрутизатора. Сторож держит форму ответа (RouteBuildResult,
 * тот же тип, что уже понимает экран из PR 5A), gate по режиму (car — зовёт
 * провайдера, foot — честный unsupported: 5B-2 не построен) и конверт края.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const routeMock = vi.fn();
vi.mock('@/lib/on-route/route-provider', () => ({
  notWiredCarRouteProvider: { route: (...a: unknown[]) => routeMock(...a) },
}));

const rateCheckMock = vi.fn(() => true);
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: (ip: string) => rateCheckMock(ip) }),
  getClientIp: () => '1.2.3.4',
}));

import { POST } from '@/app/api/routes/build/route';

const AVACHA = { kind: 'place' as const, id: 'p1', title: 'Вулкан Авачинский', lat: 53.256, lon: 158.833 };
const PPK = { kind: 'current' as const, lat: 53.0195, lon: 158.6494 };

function req(body: unknown): NextRequest {
  return new Request('http://l/api/routes/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  rateCheckMock.mockReturnValue(true);
  routeMock.mockResolvedValue({ status: 'not_wired', message: 'источник не выбран' });
});

describe('форма запроса', () => {
  it('корректная пара origin/destination/car доходит до провайдера', async () => {
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'car' }));
    expect(res.status).toBe(200);
    expect(routeMock).toHaveBeenCalledTimes(1);
    const arg = routeMock.mock.calls[0][0];
    expect(arg).toEqual({ originLat: PPK.lat, originLon: PPK.lon, destLat: AVACHA.lat, destLon: AVACHA.lon });
  });

  it('некорректное тело — 400, провайдер не зовётся', async () => {
    const res = await POST(req({ origin: {}, destination: AVACHA, mode: 'car' }));
    expect(res.status).toBe(400);
    expect(routeMock).not.toHaveBeenCalled();
  });

  it('неизвестный kind у destination отвергается схемой', async () => {
    const res = await POST(req({ origin: PPK, destination: { kind: 'route', id: 'x' }, mode: 'car' }));
    expect(res.status).toBe(400);
  });
});

describe('режим foot — честный unsupported, провайдер не зовётся', () => {
  it('5B-2 не построен: pedestrian off-trail routing не обещан', async () => {
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'foot' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.status).toBe('unsupported');
    expect(json.result.reason).toMatch(/троп/);
    expect(routeMock).not.toHaveBeenCalled();
  });
});

describe('режим car — нормализует ответ провайдера в RouteBuildResult', () => {
  it('not_wired → unsupported с тем же текстом', async () => {
    routeMock.mockResolvedValue({ status: 'not_wired', message: 'провайдер не выбран' });
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'car' }));
    const json = await res.json();
    expect(json.result).toEqual({ status: 'unsupported', reason: 'провайдер не выбран' });
  });

  it('error → failed, retryable проброшен как есть', async () => {
    routeMock.mockResolvedValue({ status: 'error', retryable: true, message: 'таймаут' });
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'car' }));
    const json = await res.json();
    expect(json.result).toEqual({ status: 'failed', retryable: true, message: 'таймаут' });
  });

  it('error non-retryable остаётся non-retryable', async () => {
    routeMock.mockResolvedValue({ status: 'error', retryable: false, message: 'лимит исчерпан' });
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'car' }));
    const json = await res.json();
    expect(json.result.retryable).toBe(false);
  });
});

describe('конверт края — грубый фильтр, не выдаёт координату вне Камчатки', () => {
  it('точка далеко за пределами края — unsupported, провайдер не зовётся', async () => {
    const MOSCOW = { kind: 'coordinate' as const, lat: 55.75, lon: 37.62 };
    const res = await POST(req({ origin: MOSCOW, destination: AVACHA, mode: 'car' }));
    const json = await res.json();
    expect(json.result.status).toBe('unsupported');
    expect(routeMock).not.toHaveBeenCalled();
  });
});

describe('rate-limit', () => {
  it('превышение лимита — 429, провайдер не зовётся', async () => {
    rateCheckMock.mockReturnValue(false);
    const res = await POST(req({ origin: PPK, destination: AVACHA, mode: 'car' }));
    expect(res.status).toBe(429);
    expect(routeMock).not.toHaveBeenCalled();
  });
});
