/**
 * IndexedDB хранилище офлайн-данных KamchatourHub.
 * Использует idb (Jake Archibald) как обёртку над IndexedDB API.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RegionId } from '@/lib/geo/regions';

// ─── Schema ──────────────────────────────────────────────────────────────────

export interface RegionMeta {
  id: RegionId;
  downloadedAt: number;
  version: number;
  tilesCount: number;
  routesCount: number;
  sizeBytes: number;
  /**
   * Сколько тайлов НЕ скачалось при закачке. Отсутствие поля (старые записи)
   * читать как 0 — «о неудачах не знаем», а не «их не было». Ненулевое
   * значение обязано доехать до статуса: частичный пакет не бывает «cached».
   */
  tilesFailed?: number;
}

export interface OfflineRoute {
  id: string;
  regionId: RegionId;
  title: string;
  description: string;
  lat: number;
  lng: number;
  kind: string;
  category: string | null;
  locationType: string | null;
  activityType: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  priceFrom: number | null;
  difficulty: string | null;
  durationDays: number | null;
  bestMonths: number[] | null;
  geometry: { type: string; coordinates: [number, number][]; color?: string; weight?: number } | null;
  /**
   * Активные ограничения на момент скачивания пакета (issue #836): дорога
   * закрыта, пропускной режим, пожар, вулканическая опасность. В поле без
   * сети это единственный источник — раньше офлайн-пакет нёс только описание
   * и трек, и турист, скачавший регион перед выездом, о перекрытии не узнавал.
   *
   * Данные с временем: alertsAt — когда сняты. Просроченные показываем как
   * устаревшие, а не как актуальные (vedar-design §7: устаревшее не выдавать
   * за свежее).
   */
  activeAlerts: string[];
  alertSeverity: number;
  alertsAt: number | null;
  cachedAt: number;
}

/**
 * Полевой пакет маршрута — запись манифеста (тип живёт в
 * lib/offline/field-pack.ts, здесь только хранение). keyPath — routeId:
 * у маршрута один актуальный пакет; старый перезаписывается новым.
 */
export interface FieldPackRecord {
  routeId: string;
  manifest: unknown;
}

interface KamchatourDB extends DBSchema {
  regions: {
    key: RegionId;
    value: RegionMeta;
  };
  routes: {
    key: string;
    value: OfflineRoute;
    indexes: { 'by-region': RegionId };
  };
  fieldChecks: {
    key: string;
    value: FieldCheckQueueItem;
  };
  fieldCheckAreas: {
    key: string;
    value: FieldCheckArea;
  };
  fieldTracks: {
    key: string;
    value: FieldTrackDraft;
  };
  fieldPacks: {
    key: string;
    value: FieldPackRecord;
  };
  trailObservations: {
    key: string;
    value: TrailObservationDraft;
  };
}

/**
 * Наблюдение с экрана маршрута, ожидающее отправки (владелец 27.08:
 * «Наблюдение» переезжает с главной на карту маршрута).
 *
 * Тот же принцип, что у fieldChecks: СНАЧАЛА на диск, потом попытка
 * отправить. Прежняя форма на главной при отсутствии сети просто теряла
 * текст — в поле, где наблюдения и рождаются, это гарантированная потеря.
 */
export interface TrailObservationDraft {
  /** Локальный ключ: время постановки + случайный хвост. */
  id: string;
  /** animal | plant | hazard | trail | other (+legacy bear/rockfall/weather). */
  reportType: string;
  text: string;
  lat: number | null;
  lng: number | null;
  /** Снимки как base64 без префикса, уже сжатые (shrink-photo). */
  photos: string[];
  queuedAt: number;
}

/**
 * Полевая проверка записи, ожидающая отправки (форма /field-check).
 *
 * Живёт в IndexedDB, а не в localStorage: с фотографиями пятимегабайтной
 * квоты хватит на три снимка, а выход в поле — это десятки проверок.
 * Потерянная проверка равна потерянному выходу, поэтому очередь на диске
 * и переживает перезагрузку телефона.
 */
export interface FieldCheckQueueItem {
  /** Локальный ключ: время постановки + случайный хвост. */
  id: string;
  /**
   * `new` — находка: здесь есть то, чего нет в базе (владелец 22.08).
   * У находки нет targetId — записи ещё не существует, связывать не с чем.
   */
  targetKind: 'route' | 'place' | 'new';
  /** Как человек назвал находку. Только у `new`. */
  proposedName?: string | null;
  targetId: string | null;
  verdict: string;
  /** Координата проверяющего; null — проверка не с места, это законно. */
  reportedLat: number | null;
  reportedLng: number | null;
  accuracyM: number | null;
  note: string | null;
  tripTag: string | null;
  /**
   * Правильная координата ОБЪЕКТА, если проверяющий её дал, и откуда она:
   * 'my_fix' — стоял на объекте, 'manual' — ввёл руками. null — не давал.
   */
  objectLat: number | null;
  objectLng: number | null;
  objectSource: 'my_fix' | 'manual' | null;
  /** Снимки как data-URL уже сжатыми: сервер их не пережимает. */
  photos: string[];
  queuedAt: number;
}

/**
 * Заготовка выхода: список записей района, скачанный ДОМА, пока есть сеть.
 *
 * Владелец 21.08: «они собираются не на одну локацию». В поле — на
 * перевале, в долине — список «что рядом» не загрузится, и форма без
 * заготовки становится бесполезной ровно там, где нужна. Поэтому район
 * скачивается заранее и целиком лежит на телефоне.
 */
export interface FieldCheckArea {
  /** Ключ: 'current' — заготовка одна, лишние копии в поле только путают. */
  id: string;
  label: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  /** Записи как их отдаёт /api/field-check/nearby. */
  items: unknown[];
  savedAt: number;
}

/**
 * Идущая запись трека. Хранится на диске, а не в памяти вкладки: система
 * усыпляет и выгружает вкладку без спроса, и запись, пережившая полдня
 * ходьбы, не должна умирать от того, что человек переключился на камеру.
 *
 * Одна запись за раз — ключ постоянный. Две одновременные записи в поле
 * это не возможность, а способ потерять обе.
 */
export interface FieldTrackDraft {
  id: 'current';
  name: string;
  startedAt: number;
  /** Принятые точки: [lat, lng, высота|null, время]. */
  points: Array<[number, number, number | null, number]>;
  /** Отброшенные засечки по причинам — отказ съёмки обязан быть виден. */
  dropped: Record<string, number>;
  lengthM: number;
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

const DB_NAME = 'kamchatour-offline';
// v2 — у OfflineRoute появились activeAlerts/alertSeverity/alertsAt (#836).
// Схема хранилищ не менялась (те же keyPath/индексы), поэтому апгрейд —
// без миграции данных: старые записи просто не имеют полей, читатели дают
// им дефолты (пустой список, severity 0, alertsAt null → «данных нет»).
// v3 — store fieldPacks: манифест полевого пакета маршрута (план FCN, этап 2).
// v4 — store fieldChecks: очередь полевых проверок с фотографиями (форма
// /field-check, владелец 21.08). Снимок с телефона в localStorage не влезает,
// а в поле именно фотография решает спор о том, что там на земле.
// v5 — store fieldCheckAreas: заготовка выхода, скачанная дома. Выход идёт
// по маршруту, а не по одной точке, и на перевале список уже не подгрузить.
// v6 — store fieldTracks: идущая запись трека. На диске, а не в памяти
// вкладки: система выгружает вкладку без спроса, и полдня ходьбы не должны
// пропасть от переключения на камеру.
// v7 — store trailObservations: очередь наблюдений с экрана маршрута
// (владелец 27.08). Прежняя форма на главной без сети теряла текст —
// наблюдение рождается в поле, где сети чаще всего и нет.
const DB_VERSION = 7;

let _db: IDBPDatabase<KamchatourDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<KamchatourDB>> {
  if (_db) return _db;

  _db = await openDB<KamchatourDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('regions')) {
        db.createObjectStore('regions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('routes')) {
        const store = db.createObjectStore('routes', { keyPath: 'id' });
        store.createIndex('by-region', 'regionId');
      }
      // sosContacts здесь больше не заводится: номера спасения живут в
      // lib/safety/emergency-numbers.ts, приезжают в каждый бандл и лежат в
      // офлайн-странице /emergency. Копия в IndexedDB писалась и никем не
      // читалась — то есть могла разойтись с реестром, ничего не давая
      // взамен. У старых баз стор остаётся пустым и никому не мешает.
      if (!db.objectStoreNames.contains('fieldPacks')) {
        db.createObjectStore('fieldPacks', { keyPath: 'routeId' });
      }
      if (!db.objectStoreNames.contains('fieldChecks')) {
        db.createObjectStore('fieldChecks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fieldCheckAreas')) {
        db.createObjectStore('fieldCheckAreas', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fieldTracks')) {
        db.createObjectStore('fieldTracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('trailObservations')) {
        db.createObjectStore('trailObservations', { keyPath: 'id' });
      }
    },
  });

  return _db;
}

// ─── Field packs ─────────────────────────────────────────────────────────────

export async function saveFieldPackRecord(rec: FieldPackRecord): Promise<void> {
  const db = await getDB();
  await db.put('fieldPacks', rec);
}

export async function getFieldPackRecord(routeId: string): Promise<FieldPackRecord | undefined> {
  const db = await getDB();
  return db.get('fieldPacks', routeId);
}

/**
 * Все сохранённые полевые пакеты.
 *
 * Нужно, чтобы решить, держит ли тайл кто-то ещё: пакет маршрута лежит внутри
 * региона и делит с ним адреса. Без списка удаление региона проделало бы дыру
 * в карте пакета, и обнаружилось бы это в поле.
 */
export async function listFieldPackRecords(): Promise<FieldPackRecord[]> {
  const db = await getDB();
  return db.getAll('fieldPacks');
}

export async function deleteFieldPackRecord(routeId: string): Promise<void> {
  const db = await getDB();
  await db.delete('fieldPacks', routeId);
}

// ─── Очередь полевых проверок ────────────────────────────────────────────────

export async function queueFieldCheck(item: FieldCheckQueueItem): Promise<void> {
  const db = await getDB();
  await db.put('fieldChecks', item);
}

/** Всё, что ещё не ушло, — в порядке постановки: улика не переставляется. */
export async function listFieldChecks(): Promise<FieldCheckQueueItem[]> {
  const db = await getDB();
  const all = await db.getAll('fieldChecks');
  return all.sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function deleteFieldCheck(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('fieldChecks', id);
}

// ─── Очередь наблюдений с экрана маршрута ────────────────────────────────────

export async function queueTrailObservation(item: TrailObservationDraft): Promise<void> {
  const db = await getDB();
  await db.put('trailObservations', item);
}

export async function listTrailObservations(): Promise<TrailObservationDraft[]> {
  const db = await getDB();
  const all = await db.getAll('trailObservations');
  return all.sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function deleteTrailObservation(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('trailObservations', id);
}

// ─── Заготовка выхода ────────────────────────────────────────────────────────

export async function saveFieldCheckArea(area: FieldCheckArea): Promise<void> {
  const db = await getDB();
  await db.put('fieldCheckAreas', area);
}

export async function getFieldCheckArea(id = 'current'): Promise<FieldCheckArea | undefined> {
  const db = await getDB();
  return db.get('fieldCheckAreas', id);
}

// ─── Regions ─────────────────────────────────────────────────────────────────

export async function saveRegion(meta: RegionMeta): Promise<void> {
  const db = await getDB();
  await db.put('regions', meta);
}

export async function getRegion(id: RegionId): Promise<RegionMeta | undefined> {
  const db = await getDB();
  return db.get('regions', id);
}

export async function listRegions(): Promise<RegionMeta[]> {
  const db = await getDB();
  return db.getAll('regions');
}

export async function deleteRegion(id: RegionId): Promise<void> {
  const db = await getDB();
  await db.delete('regions', id);
  // Удаление маршрутов раньше было ЗДЕСЬ отдельной копией того же кода, что
  // и в `deleteRoutesByRegion` ниже, — строка в строку. Два места об одном
  // расходятся молча; перепись 22.08.2026 показала копию, потому что
  // «оригинал» при этом числился никем не вызванным.
  await deleteRoutesByRegion(id);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function saveRoutes(routes: OfflineRoute[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('routes', 'readwrite');
  await Promise.all(routes.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function getRoutesByRegion(regionId: RegionId): Promise<OfflineRoute[]> {
  const db = await getDB();
  return db.getAllFromIndex('routes', 'by-region', regionId);
}

export async function getAllOfflineRoutes(): Promise<OfflineRoute[]> {
  const db = await getDB();
  return db.getAll('routes');
}

export async function deleteRoutesByRegion(regionId: RegionId): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('routes', 'readwrite');
  const index = tx.store.index('by-region');
  const keys = await index.getAllKeys(regionId);
  await Promise.all(keys.map((k) => tx.store.delete(k)));
  await tx.done;
}

// ─── Storage estimate ────────────────────────────────────────────────────────

export interface StorageEstimate {
  quota?: number;
  usage?: number;
  usagePercent?: number;
}

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined') return null;
  if (!('storage' in navigator) || !('estimate' in navigator.storage)) return null;

  const est = await navigator.storage.estimate();
  const quota = est.quota;
  const usage = est.usage;
  const usagePercent =
    quota && usage ? Math.round((usage / quota) * 100) : undefined;

  return { quota, usage, usagePercent };
}

// ─── Контактов спасения здесь нет ───────────────────────────────────────────
// Намеренно: GLOBAL_SOS_CONTACTS писались в
// стор sosContacts, которого никто не читал (getSosContactsByRegion без
// вызывающих). Источник номеров — lib/safety/emergency-numbers.ts, он
// приезжает в бандл и лежит в офлайн-странице /emergency. Копия, которую
// только пишут, умеет одно: разойтись с реестром (перепись 22.08).

// ─── Идущая запись трека ─────────────────────────────────────────────────────

export async function saveTrackDraft(draft: FieldTrackDraft): Promise<void> {
  const db = await getDB();
  await db.put('fieldTracks', draft);
}

export async function getTrackDraft(): Promise<FieldTrackDraft | undefined> {
  const db = await getDB();
  return db.get('fieldTracks', 'current');
}

export async function clearTrackDraft(): Promise<void> {
  const db = await getDB();
  await db.delete('fieldTracks', 'current');
}
