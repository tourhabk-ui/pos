'use client';

/**
 * Полевой пакет маршрута — проверяемая готовность к полю, а не декларация.
 *
 * План Field Confidence Navigator, этап 2. До пакета готовность была
 * размазана: тайлы в Cache Storage, запись о карте в localStorage, точки в
 * localStorage, снимка условий офлайн не было вовсе, а трека — тем более:
 * без сети линия маршрута не поднималась вообще, и field mode честно
 * деградировал до наброска из точек, теряя снятый трек, который человек
 * видел при сохранении.
 *
 * Манифест собирает всё в одну запись (IndexedDB, store fieldPacks) и —
 * главное — умеет ПРОВЕРЯТЬ себя: запись о закачке не равна наличию тайлов
 * (система чистит кэш, не трогая записи), поэтому статус каждого ассета
 * выясняется делом, а не памятью.
 *
 * Инварианты:
 *  - partial никогда не выглядит как ready;
 *  - у снимка условий всегда виден возраст; старше порога — stale;
 *  - пакет привязан к редакции маршрута (routeVersion, миграция 863):
 *    линия могла поменяться после закачки, и пакет обязан уметь это сказать.
 */

import {
  saveFieldPackRecord, getFieldPackRecord, deleteFieldPackRecord,
} from '@/lib/offline/db';

export type PackAssetStatus = 'ready' | 'partial' | 'missing' | 'stale';

export interface PackTilesInfo {
  total: number;
  failed: number;
  droppedZooms: number[];
  coverage: 'corridor' | 'bbox';
  bufferKm: number | null;
  mb: number;
  /** Пример URL тайлов для выборочной проверки Cache Storage. */
  sampleUrls: string[];
}

export interface PackSafetySnapshot {
  hasAlert: boolean;
  maxSeverity: number;
  topTitle: string | null;
  source: string;
  /** Когда снимок сделан (мс). Возраст обязан быть виден на экране. */
  at: number;
  /** true — источник был недоступен: снимок есть, данных в нём нет. */
  unavailable: boolean;
}

export interface FieldPackManifest {
  routeId: string;
  /** Редакция маршрута на момент сборки (kamchatka_routes.route_version). */
  routeVersion: number;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** Линия пути: без неё поле без сети остаётся без трека. */
  route: {
    track: Array<[number, number]> | null;
    trackDm: number[] | null;
    geometrySource: string | null;
  };
  waypoints: Array<{ lat: number; lng: number; name: string }>;
  tiles: PackTilesInfo | null;
  safety: PackSafetySnapshot | null;
  storage: { persistent: boolean };
}

export interface PackAssetState {
  kind: 'tiles' | 'route' | 'waypoints' | 'safety_snapshot';
  status: PackAssetStatus;
  /** Короткое пояснение статуса — словами, для строки готовности. */
  note: string;
}

/** Снимок условий старше суток — устарел: пересмотреть перед выходом. */
export const SAFETY_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

export async function saveFieldPack(manifest: FieldPackManifest): Promise<void> {
  await saveFieldPackRecord({ routeId: manifest.routeId, manifest });
}

export async function loadFieldPack(routeId: string): Promise<FieldPackManifest | null> {
  try {
    const rec = await getFieldPackRecord(routeId);
    const m = rec?.manifest as FieldPackManifest | undefined;
    // Защитная проверка формы: битая запись — это «пакета нет», а не падение.
    if (!m || typeof m !== 'object' || m.routeId !== routeId) return null;
    return m;
  } catch {
    return null;
  }
}

export async function removeFieldPack(routeId: string): Promise<void> {
  try { await deleteFieldPackRecord(routeId); } catch { /* нет записи — нет работы */ }
}

/**
 * Выборочная проверка тайлов в Cache Storage — та же логика, что у офлайн-
 * регионов: память о закачке не равна наличию данных. `null` — проверить
 * нечем (нет API): остаётся верить записи.
 */
async function sampleTilesPresent(urls: string[]): Promise<boolean | null> {
  if (typeof caches === 'undefined' || urls.length === 0) return null;
  try {
    const hits = await Promise.all(urls.map(u => caches.match(u)));
    return hits.some(h => h !== undefined);
  } catch {
    return null;
  }
}

/**
 * Статусы ассетов пакета — проверкой, не памятью.
 *
 * Каждый ассет отвечает сам за себя: у карты может не хватать зумов, снимок
 * условий может устареть, а трека может не быть вовсе (points_only-маршрут) —
 * и всё это разные слова, а не общий флажок «готово».
 */
export async function verifyFieldPack(
  m: FieldPackManifest,
  now: number = Date.now(),
): Promise<PackAssetState[]> {
  const states: PackAssetState[] = [];

  // Точки: без них полю не к чему вести.
  states.push(m.waypoints.length > 0
    ? { kind: 'waypoints', status: 'ready', note: `${m.waypoints.length} точек` }
    : { kind: 'waypoints', status: 'missing', note: 'Точек маршрута нет' });

  // Линия: у points_only-маршрута её нет по природе — это missing с честным
  // словом, а не ошибка пакета.
  states.push(m.route.track && m.route.track.length >= 2
    ? { kind: 'route', status: 'ready', note: 'Линия сохранена' }
    : { kind: 'route', status: 'missing', note: 'Линии нет — ориентирование по точкам' });

  // Тайлы: запись о закачке проверяется пробой Cache Storage.
  if (!m.tiles) {
    states.push({ kind: 'tiles', status: 'missing', note: 'Карта не сохранена' });
  } else {
    const present = await sampleTilesPresent(m.tiles.sampleUrls);
    if (present === false) {
      states.push({ kind: 'tiles', status: 'missing', note: 'Карта была сохранена, но вычищена системой' });
    } else if (m.tiles.failed > 0) {
      states.push({ kind: 'tiles', status: 'partial', note: `Не хватает ${m.tiles.failed} из ${m.tiles.total} фрагментов` });
    } else if (m.tiles.droppedZooms.length > 0) {
      states.push({ kind: 'tiles', status: 'partial', note: 'Детальные слои не поместились — вблизи карта грубее' });
    } else {
      states.push({ kind: 'tiles', status: 'ready', note: 'Карта сохранена' });
    }
  }

  // Снимок условий: возраст — часть статуса.
  if (!m.safety || m.safety.unavailable) {
    states.push({ kind: 'safety_snapshot', status: 'missing', note: 'Условия не получены — проверьте до выхода' });
  } else if (now - m.safety.at > SAFETY_SNAPSHOT_STALE_MS) {
    states.push({ kind: 'safety_snapshot', status: 'stale', note: `Условия устарели (${formatSnapshotAge(m.safety.at, now)})` });
  } else {
    states.push({ kind: 'safety_snapshot', status: 'ready', note: `Условия: ${formatSnapshotAge(m.safety.at, now)}` });
  }

  return states;
}

/**
 * Готовность пакета к полю. `ready` требует: точки на месте; линия на месте
 * ИЛИ её отсутствие — природа маршрута (points_only, пакет собирался без
 * линии); карта ready. partial и вычищенная карта — НЕ ready: неполный
 * пакет, выданный за готовый, обнаруживается уже без связи.
 * Снимок условий готовности не блокирует (в поле он может быть stale по
 * определению), но его возраст обязан быть виден.
 */
export function fieldPackReadiness(states: PackAssetState[]): 'ready' | 'partial' | 'not_ready' {
  const by = (k: PackAssetState['kind']) => states.find(s => s.kind === k);
  const wps = by('waypoints');
  const tiles = by('tiles');
  if (!wps || wps.status !== 'ready') return 'not_ready';
  if (!tiles || tiles.status === 'missing') return 'not_ready';
  if (tiles.status === 'partial') return 'partial';
  return 'ready';
}

export function formatSnapshotAge(atMs: number, now: number = Date.now()): string {
  const min = Math.max(0, Math.floor((now - atMs) / 60_000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
