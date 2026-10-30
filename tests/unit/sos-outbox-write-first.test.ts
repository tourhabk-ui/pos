/**
 * Порядок «запись → отправка» у офлайн-очереди SOS (#2802).
 *
 * До правки экран /sos писал очередь только в ветке отказа `fetch`: пока
 * запрос висел, сигнал не существовал нигде — ни на сервере, ни на телефоне.
 * Телефон, умерший в эту секунду, уносил SOS без следа.
 *
 * Сторож судит ПОВЕДЕНИЕ, а не текст исходника (CLAUDE.md, решение 13.10):
 * хранилище и сеть подставляются, и правило проверяется вызовом. Подставляется
 * именно хранилище, а не IndexedDB: в node её нет, а `outbox.ts` для того и
 * написан без неё — «хранилище и сеть подставляются».
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueSOSFirst,
  dropPendingSOS,
  drainPendingSOSOnce,
  pendingKind,
  type PendingSOS,
  type PendingStore,
} from '@/lib/offline/pending-queue';
import { enqueueFirst, memoryStore } from '@/lib/offline/outbox';

/** Хранилище телефона в памяти: тот же договор, что у IndexedDB-версии. */
function store(): PendingStore & { all(): PendingSOS[] } {
  const map = new Map<string, PendingSOS>();
  return {
    async list() { return [...map.values()]; },
    async put(item) { map.set(item.id, item); },
    async remove(id) { map.delete(id); },
    all() { return [...map.values()]; },
  };
}

const payload = {
  lat: 53.0,
  lng: 158.6,
  accuracy: 10,
  tourist_name: 'Тест',
  tourist_phone: '+70000000000',
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('enqueueFirst: запись ложится до сети', () => {
  it('fetch отвергнут — запись всё равно в очереди', async () => {
    const db = store();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const queued = await enqueueSOSFirst(payload, db);
    expect(queued.kind).toBe('queued');

    // Отправка идёт ТОЛЬКО после резолва записи — и падает.
    await expect(fetchImpl('/api/safety/sos')).rejects.toThrow('network down');

    expect(db.all()).toHaveLength(1);
    expect(db.all()[0].lat).toBe(53.0);
  });

  it('SOS-событие не теряется офлайн: в хранилище остаётся запись рода sos', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);

    const kept = db.all();
    expect(kept).toHaveLength(1);
    expect(pendingKind(kept[0])).toBe('sos');
    expect(kept[0].id).toMatch(/^sos_/);
    expect(kept[0].queuedAt).toBeGreaterThan(0);
  });

  it('чужой сигнал на хранении различается родом relay', async () => {
    const db = store();
    await enqueueSOSFirst(
      { ...payload, relay: { sos_id: 'abc', relayed_by: 'dev-1' } },
      db,
    );
    expect(pendingKind(db.all()[0])).toBe('relay');
  });

  it('диска нет — это третий исход, а не успех: no-disk с причиной и в логе', async () => {
    const broken = {
      async put() { throw new Error('QuotaExceededError'); },
    };
    const out = await enqueueFirst(broken, { id: 'sos_1' }, 'офлайн-SOS');

    expect(out.kind).toBe('no-disk');
    if (out.kind === 'no-disk') expect(out.reason).toContain('QuotaExceeded');
    // Отказ не глушится: §4.0 требует след, а не «данных нет».
    expect(errorSpy).toHaveBeenCalled();
  });

  it('put резолвится до того, как вызывающий пошёл в сеть', async () => {
    const order: string[] = [];
    const slow = {
      async put() {
        await new Promise((r) => setTimeout(r, 5));
        order.push('put');
      },
    };
    await enqueueFirst(slow, { id: 'sos_2' });
    order.push('fetch');
    expect(order).toEqual(['put', 'fetch']);
  });
});

describe('drain: подтверждённая запись снимается ровно один раз', () => {
  it('сеть вернулась — запись уходит и исчезает из очереди, дублей нет', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);

    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const first = await drainPendingSOSOnce(db, fetchImpl as unknown as typeof fetch);

    expect(first).toEqual({ sent: 1, kept: 0 });
    expect(db.all()).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Второй проход слать уже нечего — повторной отправки не случается.
    const second = await drainPendingSOSOnce(db, fetchImpl as unknown as typeof fetch);
    expect(second).toEqual({ sent: 0, kept: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('отказ сети — запись остаётся и уходит следующим проходом', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);

    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await drainPendingSOSOnce(db, failing as unknown as typeof fetch)).toEqual({ sent: 0, kept: 1 });
    expect(db.all()).toHaveLength(1);

    const ok = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    expect(await drainPendingSOSOnce(db, ok as unknown as typeof fetch)).toEqual({ sent: 1, kept: 0 });
    expect(db.all()).toHaveLength(0);
  });

  it('429 — сервер уже принял: запись снимается, а не копится', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);

    const limited = vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response);
    expect(await drainPendingSOSOnce(db, limited as unknown as typeof fetch)).toEqual({ sent: 1, kept: 0 });
    expect(db.all()).toHaveLength(0);
  });

  it('чужой сигнал уходит на /api/mesh/sos-relay, свой — на /api/safety/sos', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);
    await enqueueSOSFirst({ ...payload, relay: { sos_id: 'abc', relayed_by: 'dev-1' } }, db);

    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200 } as Response;
    });
    await drainPendingSOSOnce(db, fetchImpl as unknown as typeof fetch);

    expect(seen).toContain('/api/safety/sos');
    expect(seen).toContain('/api/mesh/sos-relay');
    expect(db.all()).toHaveLength(0);
  });

  it('офлайн — проход не трогает очередь и не выдаёт её за отправленную', async () => {
    const db = store();
    await enqueueSOSFirst(payload, db);
    vi.stubGlobal('navigator', { onLine: false });

    const fetchImpl = vi.fn();
    expect(await drainPendingSOSOnce(db, fetchImpl as unknown as typeof fetch)).toEqual({ sent: 0, kept: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.all()).toHaveLength(1);
  });
});

describe('dropPendingSOS: снятие подтверждённой записи', () => {
  it('подтверждённый приём снимает запись — досыл её не повторит', async () => {
    const db = store();
    const queued = await enqueueSOSFirst(payload, db);
    expect(db.all()).toHaveLength(1);

    await dropPendingSOS(queued.id, db);
    expect(db.all()).toHaveLength(0);

    const fetchImpl = vi.fn();
    expect(await drainPendingSOSOnce(db, fetchImpl as unknown as typeof fetch)).toEqual({ sent: 0, kept: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('снять не вышло — отказ не глушится, запись остаётся и уйдёт досылом', async () => {
    const db = store();
    const queued = await enqueueSOSFirst(payload, db);
    const broken: PendingStore = {
      ...db,
      async remove() { throw new Error('store closed'); },
    };

    await expect(dropPendingSOS(queued.id, broken)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(db.all()).toHaveLength(1);
  });
});

describe('memoryStore из outbox годится как EnqueueStore', () => {
  it('enqueueFirst кладёт запись в общий memoryStore', async () => {
    const mem = memoryStore<{ id: string; photos: string[] }>();
    const out = await enqueueFirst(mem, { id: 'x1', photos: [] });
    expect(out).toEqual({ kind: 'queued', id: 'x1' });
    expect(mem.items()).toHaveLength(1);
  });
});
