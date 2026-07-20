'use client';

import { openDB } from 'idb';

const DB_NAME = 'kh-pending-v1';
const DB_VERSION = 1;

export interface PendingSOS {
  id: string;
  queuedAt: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  tourist_name: string | null;
  tourist_phone: string | null;
}

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('pending_sos')) {
        db.createObjectStore('pending_sos', { keyPath: 'id' });
      }
    },
  });
}

export async function queueSOS(data: Omit<PendingSOS, 'id' | 'queuedAt'>): Promise<void> {
  const db = await getDB();
  const entry: PendingSOS = {
    ...data,
    id: `sos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    queuedAt: Date.now(),
  };
  await db.put('pending_sos', entry);
}

export async function registerSOSSync(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  try {
    const sw = await navigator.serviceWorker.ready;
    if (!('sync' in sw)) return false;
    await (sw.sync as { register(tag: string): Promise<void> }).register('sos-sync');
    return true;
  } catch {
    return false;
  }
}

// ── Foreground flush (страховка для браузеров без Background Sync) ──────────
// iOS Safari / все iOS-браузеры (WebKit) НЕ поддерживают Background Sync API,
// поэтому registerSOSSync там возвращает false, а SW-обработчик 'sos-sync'
// никогда не срабатывает — офлайн-SOS завис бы в IndexedDB навсегда. Этот
// флаш дослывает очередь из основного потока: при возврате сети ('online')
// и при загрузке приложения. Идемпотентно: сервер на повтор отвечает 429,
// который мы трактуем как «уже принято» и удаляем запись.

/** Чистая логика дослыва: тестируется без IndexedDB и сети. */
export async function flushPendingItems(
  items: PendingSOS[],
  send: (item: PendingSOS) => Promise<{ ok: boolean; status: number }>,
  remove: (id: string) => Promise<void>,
): Promise<{ sent: number; kept: number }> {
  let sent = 0;
  let kept = 0;
  for (const item of items) {
    try {
      const res = await send(item);
      // 429 = rate-limited = сервер уже получил этот SOS → тоже удаляем
      if (res.ok || res.status === 429) {
        await remove(item.id);
        sent++;
      } else {
        kept++;
      }
    } catch {
      kept++; // сеть ещё недоступна — оставляем на следующую попытку
    }
  }
  return { sent, kept };
}

export async function flushPendingSOS(): Promise<{ sent: number; kept: number }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { sent: 0, kept: 0 };
  }
  const db = await getDB();
  const items = (await db.getAll('pending_sos')) as PendingSOS[];
  if (items.length === 0) return { sent: 0, kept: 0 };
  return flushPendingItems(
    items,
    async (item) => {
      const res = await fetch('/api/safety/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: item.lat,
          lng: item.lng,
          accuracy: item.accuracy,
          tourist_name: item.tourist_name,
          tourist_phone: item.tourist_phone,
        }),
      });
      return { ok: res.ok, status: res.status };
    },
    async (id) => { await db.delete('pending_sos', id); },
  );
}

let flushInstalled = false;

/** Ставит дослыв очереди на событие возврата сети и на старт приложения. */
export function installSOSFlush(): void {
  if (typeof window === 'undefined' || flushInstalled) return;
  flushInstalled = true;
  const run = () => { void flushPendingSOS(); };
  window.addEventListener('online', run);
  // iOS Safari без Background Sync: добираем зависшую очередь при загрузке.
  run();
}
