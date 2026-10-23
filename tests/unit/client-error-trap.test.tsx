// @vitest-environment jsdom
/**
 * Ловушка ошибок браузера (решение владельца 13.10) — поведением в jsdom:
 * событие в окне → доклад на /api/client-errors; шум не шлётся; повтор и
 * потолок держатся; офлайн ложится в очередь и досылается с сетью; граница
 * React докладывает сама.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { resetReportState, MAX_PER_LOAD, QUEUE_KEY, CLIENT_ERRORS_ENDPOINT } from '@/lib/client-errors/report';

type Sent = { url: string; payload: Record<string, unknown> };

async function readBlob(b: Blob): Promise<string> {
  return typeof b.text === 'function' ? b.text() : new Response(b).text();
}

function armBeacon(): { sent: Sent[]; beacon: ReturnType<typeof vi.fn> } {
  const sent: Sent[] = [];
  const raw: Array<{ url: string; blob: Blob }> = [];
  const beacon = vi.fn((url: string, blob: Blob) => { raw.push({ url, blob }); return true; });
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
  // Синхронно прочитать Blob нельзя — тесты зовут drain().
  (beacon as unknown as { drain: () => Promise<Sent[]> }).drain = async () => {
    while (raw.length) {
      const { url, blob } = raw.shift() as { url: string; blob: Blob };
      sent.push({ url, payload: JSON.parse(await readBlob(blob)) as Record<string, unknown> });
    }
    return sent;
  };
  return { sent, beacon };
}

const drain = (beacon: ReturnType<typeof vi.fn>) => (beacon as unknown as { drain: () => Promise<Sent[]> }).drain();

function setOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
}

function fireError(err: unknown, message = 'boom') {
  // jsdom: окно получает ErrorEvent как при необработанном исключении.
  window.dispatchEvent(new ErrorEvent('error', { message, error: err as Error }));
}

function fireRejection(reason: unknown) {
  const ev = new Event('unhandledrejection');
  Object.assign(ev, { reason });
  window.dispatchEvent(ev);
}

beforeEach(() => {
  resetReportState();
  localStorage.clear();
  setOnline(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('перехватчик окна', () => {
  it('ошибка и отклонённый промис уходят на приёмник с путём без query; повтор не шлётся', async () => {
    const { beacon } = armBeacon();
    window.history.pushState({}, '', '/catalog/tours/51?utm=x#top');
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));

    fireError(new Error('boom at TourGrid'));
    fireError(new Error('boom at TourGrid'));
    fireRejection(new Error('rejected fetch'));
    const sent = await drain(beacon);

    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe(CLIENT_ERRORS_ENDPOINT);
    expect(sent[0].payload).toMatchObject({ kind: 'error', message: 'boom at TourGrid', path: '/catalog/tours/51', online: true });
    expect(typeof sent[0].payload.occurred_at).toBe('string');
    expect(sent[1].payload).toMatchObject({ kind: 'unhandledrejection', message: 'rejected fetch' });
  });

  it('промис, отклонённый событием, называет род события, элемент и адрес без query — не {"isTrusted":true}', async () => {
    // 23.10: с карточки маршрута пришло ровно {"isTrusted":true} — что упало, не понять.
    const { beacon } = armBeacon();
    window.history.pushState({}, '', '/routes/buhta-poludennaya-o-beringa');
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));

    const img = document.createElement('img');
    img.src = 'https://vedarai.ru/api/images/route/abc.jpg?token=secret#x';
    const ev = new Event('error');
    img.addEventListener('error', () => fireRejection(ev));
    img.dispatchEvent(ev);
    const sent = await drain(beacon);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.kind).toBe('unhandledrejection');
    expect(sent[0].payload.message).toBe('Событие «error» у img https://vedarai.ru/api/images/route/abc.jpg');
    expect(String(sent[0].payload.message)).not.toContain('token');
  });

  it('шум не шлётся: чужой «Script error.», расширение браузера, ResizeObserver', async () => {
    const { beacon } = armBeacon();
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));
    fireError(null, 'Script error.');
    const ext = new Error('x is not a function');
    ext.stack = 'TypeError: x is not a function\n    at chrome-extension://abcdef/content.js:1:1';
    fireError(ext);
    fireError(new Error('ResizeObserver loop completed with undelivered notifications.'));
    expect(await drain(beacon)).toHaveLength(0);
  });

  it(`не больше ${MAX_PER_LOAD} разных ошибок за загрузку`, async () => {
    const { beacon } = armBeacon();
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));
    for (let i = 0; i < MAX_PER_LOAD + 3; i += 1) fireError(new Error(`distinct ${i}`));
    expect(await drain(beacon)).toHaveLength(MAX_PER_LOAD);
  });

  it('офлайн: ошибка ложится в очередь localStorage и досылается, когда сеть вернулась', async () => {
    const { beacon } = armBeacon();
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));

    setOnline(false);
    fireError(new Error('offline crash'));
    expect(await drain(beacon)).toHaveLength(0);
    const queued = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as Array<{ message: string; online: boolean }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ message: 'offline crash', online: false });

    setOnline(true);
    act(() => { window.dispatchEvent(new Event('online')); });
    const sent = await drain(beacon);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ message: 'offline crash', online: false });
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it('очередь с прошлой загрузки досылается при монтировании', async () => {
    const { beacon } = armBeacon();
    localStorage.setItem(QUEUE_KEY, JSON.stringify([{ kind: 'error', message: 'left over', path: '/map', online: false, occurred_at: '2026-10-13T10:00:00.000Z' }]));
    const { default: Trap } = await import('@/components/shared/ClientErrorTrap');
    render(React.createElement(Trap));
    const sent = await drain(beacon);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ message: 'left over', path: '/map' });
  });
});

describe('граница React', () => {
  it('app/error.tsx докладывает об ошибке рендера родом boundary', async () => {
    const { beacon } = armBeacon();
    const { default: ErrorPage } = await import('@/app/error.tsx');
    const err = Object.assign(new Error('render exploded'), { digest: 'abc123' });
    render(React.createElement(ErrorPage, { error: err, reset: () => {} }));
    const sent = await drain(beacon);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ kind: 'boundary', message: 'render exploded' });
  });
});
