import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '@/lib/ai/providers';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchWithRetry (Roitman §18.7.1 exponential backoff + jitter)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a transient 429 twice and succeeds on the third attempt', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const promise = fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 401 (auth failure — OpenRouter already has its own cooldown)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(401));
    const res = await fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400 (non-transient — e.g. Anthropic safety-block, handled elsewhere)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(400));
    const res = await fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 404', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(404));
    const res = await fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    expect(res.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on a persistent 503 (initial + maxRetries attempts)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(503));
    const promise = fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('keeps each retry delay within [2^k * baseDelayMs, 2^k * baseDelayMs + baseDelayMs)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    await promise;

    // Отфильтровываем таймер sleep() от прочих (напр. внутренних у AbortSignal.timeout)
    const delays = setTimeoutSpy.mock.calls
      .map(c => c[1] as number)
      .filter(d => typeof d === 'number' && d >= 100 && d < 5000);

    expect(delays.length).toBe(2); // k=0 и k=1
    expect(delays[0]).toBeGreaterThanOrEqual(100);   // k=0: [100, 200)
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);   // k=1: [200, 300)
    expect(delays[1]).toBeLessThan(300);
  });

  it('retries a transient network error (undici "fetch failed") and succeeds', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200));

    const promise = fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries ECONNRESET and eventually throws if never recovering', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('read ECONNRESET'));
    const promise = fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 });
    // Прикрепляем обработчик отклонения ДО runAllTimersAsync — иначе финальный
    // throw происходит во время прогона таймеров раньше, чем на promise
    // навешан catch, и vitest репортит его как unhandled rejection.
    const assertion = expect(promise).rejects.toThrow(/ECONNRESET/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient error message (parse errors etc.)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new SyntaxError('Unexpected token in JSON'));
    await expect(
      fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 }),
    ).rejects.toThrow(/Unexpected token/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a deliberate timeout (AbortError) — that is a time budget, not a transient fault', async () => {
    const abortErr = new DOMException('This operation was aborted', 'AbortError');
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(
      fetchWithRetry('https://example.com', {}, { timeoutMs: 5000, maxRetries: 2, baseDelayMs: 100 }),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
