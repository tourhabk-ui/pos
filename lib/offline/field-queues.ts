'use client';

/**
 * Офлайн-очереди поля на телефоне (#2448): наблюдения с экрана маршрута и
 * полевые проверки (/field-check). Правило досыла — lib/offline/outbox;
 * здесь — какие приёмники, чем шлём и когда.
 *
 * Досыл при старте приложения и при возврате сети ставит
 * installFieldQueuesFlush — на каждой странице, как дослыв SOS
 * (components/PWA/ServiceWorkerRegistrar). До 14.10 наблюдения дожимались
 * только по событию `online` и только пока смонтирован экран маршрута:
 * открыл приложение со связью — очередь лишь считалась. Полевые проверки —
 * только пока открыта форма /field-check.
 *
 * После каждого прохода уходит событие очереди: экраны пересчитывают
 * «уйдёт само» и «не принято» по нему, а не по своему счётчику.
 */
import {
  listTrailObservations, queueTrailObservation, deleteTrailObservation,
  listFieldChecks, queueFieldCheck, deleteFieldCheck,
  type TrailObservationDraft, type FieldCheckQueueItem,
} from '@/lib/offline/db';
import {
  flushOutbox, memoryStore, serialized,
  type FlushResult, type OutboxRecord, type OutboxSpec, type OutboxStore,
} from '@/lib/offline/outbox';

export const TRAIL_OBSERVATION_QUEUE_EVENT = 'trail-observation-queued';
export const FIELD_CHECK_QUEUE_EVENT = 'field-check-queue-changed';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Наблюдение: текст и координаты, потом снимки к принятому наблюдению. */
export const TRAIL_OBSERVATIONS: OutboxSpec<TrailObservationDraft> = {
  name: 'наблюдения',
  recordUrl: '/api/safety/reports',
  recordPayload: (item) => ({
    report_type: item.reportType,
    text: item.text,
    ...(item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng } : {}),
  }),
  recordId: (body) =>
    isObject(body) && isObject(body.data) && typeof body.data.id === 'string' ? body.data.id : null,
  photoUrl: '/api/safety/reports/photo',
  photoPayload: (reportId, photo) => ({ report_id: reportId, mime: 'image/jpeg', data: photo }),
  sentId: (item) => item.sentReportId ?? null,
  withSentId: (item, id) => ({ ...item, sentReportId: id }),
};

/** Полевая проверка: вердикт один раз, потом снимки к принятой проверке. */
export const FIELD_CHECKS: OutboxSpec<FieldCheckQueueItem> = {
  name: 'полевые проверки',
  recordUrl: '/api/field-check/report',
  recordPayload: (item) => ({
    target_kind: item.targetKind,
    target_id: item.targetKind === 'new' ? null : item.targetId,
    proposed_name: item.proposedName ?? null,
    verdict: item.verdict,
    reported_lat: item.reportedLat,
    reported_lng: item.reportedLng,
    accuracy_m: item.accuracyM,
    note: item.note,
    trip_tag: item.tripTag,
    object_lat: item.objectLat,
    object_lng: item.objectLng,
    object_source: item.objectSource,
  }),
  recordId: (body) => (isObject(body) && typeof body.id === 'string' ? body.id : null),
  photoUrl: '/api/field-check/photo',
  photoPayload: (checkId, photo) => ({ check_id: checkId, mime: 'image/jpeg', data: photo }),
  sentId: (item) => item.sentCheckId ?? null,
  withSentId: (item, id) => ({ ...item, sentCheckId: id }),
};

const trailStore: OutboxStore<TrailObservationDraft> = {
  list: listTrailObservations,
  put: queueTrailObservation,
  remove: deleteTrailObservation,
};

const fieldCheckStore: OutboxStore<FieldCheckQueueItem> = {
  list: listFieldChecks,
  put: queueFieldCheck,
  remove: deleteFieldCheck,
};

function announce(event: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(event));
}

/** null — проход не выполнился (хранилище закрыто), а не «слать нечего». */
async function runPass<T extends OutboxRecord>(
  spec: OutboxSpec<T>,
  store: OutboxStore<T>,
  event: string,
): Promise<FlushResult | null> {
  try {
    return await flushOutbox(spec, store);
  } catch (err) {
    console.error(`[очередь: ${spec.name}] досыл не выполнился:`, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    announce(event);
  }
}

export const flushTrailObservations = serialized(
  () => runPass(TRAIL_OBSERVATIONS, trailStore, TRAIL_OBSERVATION_QUEUE_EVENT));

export const flushFieldChecks = serialized(
  () => runPass(FIELD_CHECKS, fieldCheckStore, FIELD_CHECK_QUEUE_EVENT));

/**
 * Записать на телефон не вышло — шлём сразу тем же правилом. Возвращает
 * запись, какой она осталась: null — ушла целиком; с `rejected` — сервер не
 * принял; без него — не ушла и, раз диска нет, пропадёт с формой.
 */
export async function sendWithoutDisk<T extends OutboxRecord>(spec: OutboxSpec<T>, item: T): Promise<T | null> {
  const store = memoryStore([item]);
  await flushOutbox(spec, store);
  return store.items()[0] ?? null;
}

/** Человек решил отправить отложенную проверку снова: снимаем отметку и шлём. */
export async function resendFieldCheck(id: string): Promise<void> {
  const item = (await listFieldChecks()).find(i => i.id === id);
  if (!item) return;
  await queueFieldCheck({ ...item, rejected: null });
  await flushFieldChecks();
}

export async function discardFieldCheck(id: string): Promise<void> {
  await deleteFieldCheck(id);
  announce(FIELD_CHECK_QUEUE_EVENT);
}

export async function discardTrailObservation(id: string): Promise<void> {
  await deleteTrailObservation(id);
  announce(TRAIL_OBSERVATION_QUEUE_EVENT);
}

let installed = false;

/** Досыл обеих очередей на старте приложения и при возврате сети. */
export function installFieldQueuesFlush(): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  const run = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void flushTrailObservations();
    void flushFieldChecks();
  };
  window.addEventListener('online', run);
  run();
}
