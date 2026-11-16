// @vitest-environment jsdom
/**
 * VolcanoMesh: SOS соседа не теряется, когда оба пути на сервер не дошли
 * (пустые catch на путях безопасности, слово владельца 16.11).
 *
 * Ретранслятор «онлайн» по флагу браузера, а запросы не проходят: слабая
 * сота, портал Wi-Fi. До правки отказ прямого пути глотался пустым catch,
 * и сигнал соседа пропадал. Теперь он ложится в ту же офлайн-очередь, что и
 * у ретранслятора без сети, а отказ самой очереди уходит в ловушку ошибок.
 *
 * Судится вызовом обработчика сообщения соседа с подложенными fetch и
 * очередью.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queueSOS, registerSOSSync, reportClientError } = vi.hoisted(() => ({
  queueSOS: vi.fn(),
  registerSOSSync: vi.fn(),
  reportClientError: vi.fn(),
}));
vi.mock('@/lib/offline/pending-queue', () => ({ queueSOS, registerSOSSync }));
vi.mock('@/lib/client-errors/report', () => ({ reportClientError }));

import { VolcanoMesh } from '@/lib/mesh/volcano-mesh';

type Internals = { handleDataMessage(peerId: string, msg: Record<string, unknown>): void };

const sosMessage = {
  type: 'sos',
  from: 'victim-device',
  timestamp: 1_700_000_000_000,
  payload: { sos_id: 'sos-1', sos: { lat: 53.1, lng: 158.6, accuracy: 20 } },
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([u]) => String(u));
}

beforeEach(() => {
  queueSOS.mockReset().mockResolvedValue(undefined);
  registerSOSSync.mockReset();
  reportClientError.mockReset();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

function deliver(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const mesh = new VolcanoMesh();
  (mesh as unknown as Internals).handleDataMessage('peer-1', sosMessage);
}

describe('ретрансляция SOS соседа при «онлайн», когда сеть не пропускает', () => {
  it('оба пути упали сетью — сигнал в офлайн-очереди с sos_id', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    deliver(fetchMock);
    for (let i = 0; i < 5; i++) await flush();
    expect(urls(fetchMock)).toEqual(['/api/mesh/sos-relay', '/api/safety/sos']);
    expect(queueSOS).toHaveBeenCalledTimes(1);
    expect(queueSOS.mock.calls[0][0]).toMatchObject({
      lat: 53.1, lng: 158.6, relay: { sos_id: 'sos-1', origin_device: 'victim-device' },
    });
  });

  it('релей 503, прямой путь 502 — тоже в очередь', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    deliver(fetchMock);
    for (let i = 0; i < 5; i++) await flush();
    expect(queueSOS).toHaveBeenCalledTimes(1);
  });

  it('прямой путь принял (200 или 429 «уже принят») — очереди нет, дубля нет', async () => {
    for (const status of [200, 429]) {
      queueSOS.mockClear();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status }));
      deliver(fetchMock);
      for (let i = 0; i < 5; i++) await flush();
      expect(queueSOS, String(status)).not.toHaveBeenCalled();
    }
  });

  it('релей принял — прямой путь не зовётся, очереди нет', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 200 }));
    deliver(fetchMock);
    for (let i = 0; i < 5; i++) await flush();
    expect(urls(fetchMock)).toEqual(['/api/mesh/sos-relay']);
    expect(queueSOS).not.toHaveBeenCalled();
  });

  it('очередь недоступна — отказ уходит в ловушку ошибок, а не глотается', async () => {
    queueSOS.mockRejectedValue(new Error('QuotaExceededError'));
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    deliver(fetchMock);
    for (let i = 0; i < 5; i++) await flush();
    expect(reportClientError).toHaveBeenCalledWith('error', expect.any(Error));
  });
});

describe('ретранслятор офлайн', () => {
  it('сигнал соседа сразу в очередь, сеть не трогается', async () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    const fetchMock = vi.fn();
    deliver(fetchMock);
    for (let i = 0; i < 5; i++) await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSOS).toHaveBeenCalledTimes(1);
  });
});
