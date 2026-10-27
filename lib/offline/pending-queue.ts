'use client';

import { openDB } from 'idb';
import { enqueueFirst, serialized, type EnqueueOutcome } from './outbox';

const DB_NAME = 'kh-pending-v1';
const DB_VERSION = 1;

/** Имя очереди в логах отказов. */
const QUEUE_NAME = 'офлайн-SOS';

export interface PendingSOS {
  id: string;
  queuedAt: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  tourist_name: string | null;
  tourist_phone: string | null;
  /** Текст пострадавшего — QR-эстафета и меш переносят его целиком. */
  message?: string | null;
  /**
   * Чужой SOS, принятый на хранение (QR-эстафета или офлайн-ретранслятор
   * меша). Несёт sos_id пострадавшего — флаш такого элемента идёт через
   * /api/mesh/sos-relay: там дедуп по sos_id (несколько человек могли
   * отсканировать один QR) и синтетический IP жертвы, чтобы rate-limit
   * канонического роута не спутал ретранслятора с пострадавшим.
   */
  relay?: {
    sos_id: string;
    relayed_by: string;
    origin_device?: string;
  };
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

/**
 * Хранилище очереди. Отдельным типом, потому что IndexedDB в node нет: сторожа
 * подставляют своё и проверяют правило вызовом, а не чтением исходника.
 */
export interface PendingStore {
  list(): Promise<PendingSOS[]>;
  put(item: PendingSOS): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Настоящее хранилище телефона. */
export const indexedDbStore: PendingStore = {
  async list() {
    const db = await getDB();
    return (await db.getAll('pending_sos')) as PendingSOS[];
  },
  async put(item) {
    const db = await getDB();
    await db.put('pending_sos', item);
  },
  async remove(id) {
    const db = await getDB();
    await db.delete('pending_sos', id);
  },
};

/**
 * Род записи: свой сигнал или чужой, принятый на хранение. Выводится, а не
 * хранится — у записей, легших до этой правки, поля бы не было, и хранимое
 * значение пришлось бы выдумывать (§4.0).
 */
export function pendingKind(item: PendingSOS): 'sos' | 'relay' {
  return item.relay ? 'relay' : 'sos';
}

function newEntry(data: Omit<PendingSOS, 'id' | 'queuedAt'>): PendingSOS {
  return {
    ...data,
    id: `sos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    queuedAt: Date.now(),
  };
}

export async function queueSOS(data: Omit<PendingSOS, 'id' | 'queuedAt'>): Promise<void> {
  await indexedDbStore.put(newEntry(data));
}

/**
 * Поставить SOS в очередь ДО сетевого вызова (#2802) и вернуть исход с
 * номером записи. Порядок «запись → отправка» держится здесь, а не в
 * вызывающем экране: пока `enqueueSOSFirst` не вернул `queued`, сигнала нет
 * нигде, и оборванный на середине `fetch` не оставил бы следа.
 *
 * Исходов два, и второй не равен первому: `no-disk` — диска нет (приватный
 * режим, переполненное хранилище). Слать тогда всё равно надо, но человеку
 * говорится правда: запись не сохранена.
 */
export async function enqueueSOSFirst(
  data: Omit<PendingSOS, 'id' | 'queuedAt'>,
  into: PendingStore = indexedDbStore,
): Promise<EnqueueOutcome> {
  return enqueueFirst(into, newEntry(data), QUEUE_NAME);
}

/**
 * Снять запись, приём которой сервер подтвердил. Отказ не глушится: запись,
 * которую не удалось снять, уйдёт повторно — сервер ответит 429, и досыл
 * снимет её как уже принятую.
 */
export async function dropPendingSOS(id: string, from: PendingStore = indexedDbStore): Promise<void> {
  try {
    await from.remove(id);
  } catch (err) {
    console.error(`[очередь: ${QUEUE_NAME}] запись ${id} не снята после подтверждения: ${err instanceof Error ? err.message : String(err)}`);
  }
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

/**
 * Тело и адрес отправки элемента очереди. Чужой SOS (relay) идёт через
 * /api/mesh/sos-relay — дедуп по sos_id; свой — в канонический роут.
 * Чистая функция: её видом занимается тест, сетью — flushPendingSOS.
 */
export function requestFor(item: PendingSOS): { url: string; body: string } {
  if (item.relay) {
    return {
      url: '/api/mesh/sos-relay',
      body: JSON.stringify({
        sos_id: item.relay.sos_id,
        relayed_by: item.relay.relayed_by,
        origin_device: item.relay.origin_device,
        sos: {
          lat: item.lat,
          lng: item.lng,
          accuracy: item.accuracy,
          message: item.message ?? null,
          tourist_name: item.tourist_name,
          tourist_phone: item.tourist_phone,
        },
      }),
    };
  }
  return {
    url: '/api/safety/sos',
    body: JSON.stringify({
      lat: item.lat,
      lng: item.lng,
      accuracy: item.accuracy,
      message: item.message ?? undefined,
      tourist_name: item.tourist_name,
      tourist_phone: item.tourist_phone,
    }),
  };
}

/**
 * Один проход по очереди. Сеть и хранилище подставляются — правило
 * проверяется вызовом.
 */
export async function drainPendingSOSOnce(
  from: PendingStore = indexedDbStore,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; kept: number }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { sent: 0, kept: 0 };
  }
  const items = await from.list();
  if (items.length === 0) return { sent: 0, kept: 0 };
  return flushPendingItems(
    items,
    async (item) => {
      const { url, body } = requestFor(item);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return { ok: res.ok, status: res.status };
    },
    async (id) => { await from.remove(id); },
  );
}

/**
 * Досыл очереди строго по одному проходу за раз. Зовут его трое — старт
 * приложения, возврат сети и экран SOS, — и два прохода внахлёст прочитали бы
 * одну запись дважды и дважды её отправили. Следующий начинается после
 * предыдущего и читает очередь заново: отправленного в ней уже нет.
 */
export const drainPendingSOS = serialized(() => drainPendingSOSOnce());

export async function flushPendingSOS(): Promise<{ sent: number; kept: number }> {
  return drainPendingSOS();
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
