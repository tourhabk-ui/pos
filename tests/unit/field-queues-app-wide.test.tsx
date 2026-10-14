// @vitest-environment jsdom
/**
 * Досыл полевых очередей со всего приложения (#2448) — рендером, а не текстом.
 *
 * До 14.10 наблюдения дожимались только по событию `online` и только пока
 * смонтирован экран маршрута, полевые проверки — только пока открыта форма
 * /field-check. Открыл приложение со связью на главной — очередь лежала.
 * Теперь досыл ставит ServiceWorkerRegistrar (корневой layout, каждая
 * страница), как дослыв SOS: на старте и при возврате сети.
 *
 * Подменены только IndexedDB (в памяти), сеть и соседи регистратора.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import type { TrailObservationDraft, FieldCheckQueueItem } from '@/lib/offline/db';

const disk = vi.hoisted(() => ({
  obs: new Map<string, unknown>(),
  checks: new Map<string, unknown>(),
}));

vi.mock('@/lib/offline/db', () => ({
  listTrailObservations: async () => [...disk.obs.values()],
  queueTrailObservation: async (i: { id: string }) => { disk.obs.set(i.id, i); },
  deleteTrailObservation: async (id: string) => { disk.obs.delete(id); },
  listFieldChecks: async () => [...disk.checks.values()],
  queueFieldCheck: async (i: { id: string }) => { disk.checks.set(i.id, i); },
  deleteFieldCheck: async (id: string) => { disk.checks.delete(id); },
}));
vi.mock('@/lib/offline/pending-queue', () => ({ installSOSFlush: vi.fn() }));
vi.mock('@/lib/offline/sw-status', () => ({ reportSwRegistration: vi.fn() }));

function obs(id: string, text: string): TrailObservationDraft {
  return { id, reportType: 'bear', text, lat: 53.1, lng: 158.6, photos: [], queuedAt: 1 };
}

function check(id: string): FieldCheckQueueItem {
  return {
    id, targetKind: 'place', targetId: 'place-1', verdict: 'ok',
    reportedLat: 53.1, reportedLng: 158.6, accuracyM: 5, note: null, tripTag: null,
    objectLat: null, objectLng: null, objectSource: null, photos: [], queuedAt: 1,
  };
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
  url === '/api/safety/reports' ? { success: true, data: { id: 'r-1' } } : { success: true, id: 'chk-1' },
), { status: url === '/api/safety/reports' ? 201 : 200, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  cleanup();
  disk.obs.clear();
  disk.checks.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setOnline(true);
});

const textsSent = () => fetchMock.mock.calls
  .filter(c => c[0] === '/api/safety/reports')
  .map(c => (JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as { text: string }).text);

describe('любая страница досылает полевые очереди', () => {
  it('на старте: наблюдение и полевая проверка уходят без открытого экрана поля', async () => {
    disk.obs.set('o1', obs('o1', 'Медведь у ручья'));
    disk.checks.set('c1', check('c1'));
    const { ServiceWorkerRegistrar } = await import('@/components/PWA/ServiceWorkerRegistrar');

    render(<ServiceWorkerRegistrar />);

    await vi.waitFor(() => {
      expect(disk.obs.size).toBe(0);
      expect(disk.checks.size).toBe(0);
    });
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining(['/api/safety/reports', '/api/field-check/report']));
  });

  it('по возврату сети — новый проход, и повторная установка не шлёт запись дважды', async () => {
    const { installFieldQueuesFlush } = await import('@/lib/offline/field-queues');
    disk.obs.set('o2', obs('o2', 'Камнепад на подъёме'));
    // Экран маршрута ставит досыл ещё раз (useTrailObservationQueue) — слушатель один.
    installFieldQueuesFlush();

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(disk.obs.size).toBe(0));
    expect(textsSent().filter(t => t === 'Камнепад на подъёме')).toHaveLength(1);
  });

  it('без сети проход не начинается — запись лежит до её возврата', async () => {
    const { installFieldQueuesFlush } = await import('@/lib/offline/field-queues');
    disk.obs.set('o3', obs('o3', 'Сход снега'));
    setOnline(false);

    installFieldQueuesFlush();
    window.dispatchEvent(new Event('online'));
    await new Promise(r => setTimeout(r, 20));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(disk.obs.has('o3')).toBe(true);
  });
});
