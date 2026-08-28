/**
 * lib/on-route/route-build.ts — httpRouteBuilder (владелец 28.08, PR 5B-1).
 *
 * Реальный транспорт до сервера, а не локальная заглушка: браузер зовёт
 * ТОЛЬКО /api/routes/build, никогда провайдера напрямую. Сторож держит
 * нормализацию сетевых исходов в RouteBuildResult и самоотмену устаревшего
 * запроса — второй build() обязан оборвать fetch первого, а не просто
 * молчать поверх него.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpRouteBuilder, type RouteBuildRequest } from '@/lib/on-route/route-build';
import type { Origin } from '@/lib/on-route/origin';
import type { Destination } from '@/lib/on-route/destination';

const origin: Origin = { kind: 'current', lat: 53.0, lon: 158.6 };
const destination: Destination = { kind: 'place', id: 'p1', title: 'Вулкан Авачинский', lat: 53.25, lon: 158.83 };
const req: RouteBuildRequest = { origin, destination, mode: 'car' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('httpRouteBuilder — единственная дверь до /api/routes/build', () => {
  it('шлёт POST на /api/routes/build с телом запроса', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: 'unsupported', reason: 'x' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await httpRouteBuilder.build(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/routes/build');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(req);
  });

  it('нормальный ответ сервера возвращается как есть', async () => {
    const result = { status: 'unsupported', reason: 'провайдер не выбран' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, result }),
    }));
    expect(await httpRouteBuilder.build(req)).toEqual(result);
  });

  it('сервер ответил не-200 — failed, retryable по классу кода', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ success: false, error: 'сбой' }),
    }));
    const result = await httpRouteBuilder.build(req);
    expect(result).toEqual({ status: 'failed', retryable: true, message: 'сбой' });
  });

  it('429 — тоже retryable (временная перегрузка, не структурный отказ)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ success: false, error: 'слишком много запросов' }),
    }));
    const result = await httpRouteBuilder.build(req);
    expect(result).toEqual({ status: 'failed', retryable: true, message: 'слишком много запросов' });
  });

  it('400 — failed, но НЕ retryable: повтор того же запроса не поможет', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ success: false, error: 'некорректный запрос' }),
    }));
    const result = await httpRouteBuilder.build(req);
    expect(result).toEqual({ status: 'failed', retryable: false, message: 'некорректный запрос' });
  });

  it('сеть недоступна (fetch бросает) — failed, retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await httpRouteBuilder.build(req);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.retryable).toBe(true);
  });
});

describe('самоотмена устаревшего запроса (не только в UI-эффекте)', () => {
  it('второй build() отменяет ещё не завершённый первый — abort реального запроса', async () => {
    const fetchMock = vi.fn()
      // Первый запрос — осознанно висит вечно: проверяем его signal, не resolve.
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => ({ success: true, result: { status: 'unsupported', reason: 'x' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = httpRouteBuilder.build(req);
    void first; // намеренно не await — первый запрос никогда не резолвится
    await httpRouteBuilder.build({ ...req, destination: { ...destination, id: 'p2' } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
  });
});
