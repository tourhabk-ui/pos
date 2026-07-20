/**
 * Дослыв офлайн-очереди SOS (страховка для браузеров без Background Sync).
 * Тестируем чистую логику flushPendingItems: удаляем при ok/429, оставляем
 * при ошибке сервера и при падении сети. Потеря SOS недопустима.
 */

import { describe, it, expect, vi } from 'vitest';
import { flushPendingItems, type PendingSOS } from '@/lib/offline/pending-queue';

const item = (id: string): PendingSOS => ({
  id,
  queuedAt: Date.now(),
  lat: 53.0,
  lng: 158.6,
  accuracy: 10,
  tourist_name: 'Тест',
  tourist_phone: '+70000000000',
});

describe('flushPendingItems', () => {
  it('успех (ok) → запись удаляется, sent++', async () => {
    const removed: string[] = [];
    const res = await flushPendingItems(
      [item('a')],
      async () => ({ ok: true, status: 200 }),
      async (id) => { removed.push(id); },
    );
    expect(res).toEqual({ sent: 1, kept: 0 });
    expect(removed).toEqual(['a']);
  });

  it('429 (уже принято сервером) → тоже удаляется', async () => {
    const removed: string[] = [];
    const res = await flushPendingItems(
      [item('b')],
      async () => ({ ok: false, status: 429 }),
      async (id) => { removed.push(id); },
    );
    expect(res).toEqual({ sent: 1, kept: 0 });
    expect(removed).toEqual(['b']);
  });

  it('ошибка сервера (500) → запись остаётся, kept++', async () => {
    const removed: string[] = [];
    const res = await flushPendingItems(
      [item('c')],
      async () => ({ ok: false, status: 500 }),
      async (id) => { removed.push(id); },
    );
    expect(res).toEqual({ sent: 0, kept: 1 });
    expect(removed).toEqual([]);
  });

  it('сеть упала (throw) → запись НЕ теряется, остаётся на следующую попытку', async () => {
    const removed: string[] = [];
    const res = await flushPendingItems(
      [item('d')],
      async () => { throw new Error('network down'); },
      async (id) => { removed.push(id); },
    );
    expect(res).toEqual({ sent: 0, kept: 1 });
    expect(removed).toEqual([]);
  });

  it('смешанная очередь: успешные удаляются, неуспешные остаются', async () => {
    const removed: string[] = [];
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })   // e1 → удалить
      .mockResolvedValueOnce({ ok: false, status: 503 })  // e2 → оставить
      .mockRejectedValueOnce(new Error('offline'));        // e3 → оставить
    const res = await flushPendingItems(
      [item('e1'), item('e2'), item('e3')],
      send,
      async (id) => { removed.push(id); },
    );
    expect(res).toEqual({ sent: 1, kept: 2 });
    expect(removed).toEqual(['e1']);
  });
});
