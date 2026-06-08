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
