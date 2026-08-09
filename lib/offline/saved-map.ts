/**
 * Что из карты лежит в телефоне — и когда легло.
 *
 * Три требования офлайн-контракта: скачано до выхода, видно что скачано,
 * названо когда скачано. Первое — дело человека, второе и третье — наше.
 *
 * Запись живёт в localStorage рядом с самими тайлами в кэше service worker.
 * Разъехаться они могут (систему никто не спрашивает, когда она чистит кэш),
 * поэтому запись — не доказательство, а заявление: «мы скачали столько-то
 * тогда-то». Проверка наличия — отдельный разговор, и врать вместо неё
 * нельзя: «сохранено» без карты хуже, чем «не сохранено».
 */

export interface SavedMapRecord {
  /** Когда скачали, мс. */
  at: number;
  tiles: number;
  mb: number;
  zooms: number[];
  /** Зумы, отброшенные потолком: карта есть, но грубее обещанной. */
  droppedZooms: number[];
  /** Коридор по треку или квадрат вокруг точки. */
  coverage: 'corridor' | 'bbox';
  bufferKm: number | null;
  /**
   * Закреплено ли хранилище. Без закрепления система вправе вычистить кэш при
   * нехватке места — без предупреждения и, по закону подлости, перед выходом.
   */
  persisted: boolean;
}

export function savedMapKey(routeId: string): string {
  return `trail_map_saved_${routeId}`;
}

export function parseSavedMap(raw: string | null): SavedMapRecord | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d?.at !== 'number' || typeof d?.tiles !== 'number') return null;
    return {
      at: d.at,
      tiles: d.tiles,
      mb: typeof d.mb === 'number' ? d.mb : 0,
      zooms: Array.isArray(d.zooms) ? (d.zooms as number[]) : [],
      droppedZooms: Array.isArray(d.droppedZooms) ? (d.droppedZooms as number[]) : [],
      coverage: d.coverage === 'bbox' ? 'bbox' : 'corridor',
      bufferKm: typeof d.bufferKm === 'number' ? d.bufferKm : null,
      persisted: d.persisted === true,
    };
  } catch {
    return null;
  }
}

/** Дата словами: «сегодня», «вчера», «9 августа». */
export function savedAtLabel(at: number, now = Date.now()): string {
  const day = 24 * 3600 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return 'сегодня';
  if (at >= startOfToday - day) return 'вчера';
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/**
 * Что сказать про скачанную карту одной строкой.
 *
 * Отброшенные зумы называем: человек рассчитывал на детальную карту, а несёт
 * грубую. Узнать об этом в поле — значит узнать слишком поздно.
 */
export function savedMapSummary(rec: SavedMapRecord, now = Date.now()): string {
  const parts = [`${rec.mb} МБ`, savedAtLabel(rec.at, now)];
  if (rec.coverage === 'corridor' && rec.bufferKm) {
    parts.unshift(`полоса ${rec.bufferKm} км вдоль маршрута`);
  } else if (rec.coverage === 'bbox') {
    parts.unshift('квадрат вокруг места');
  }
  return parts.join(' · ');
}

/**
 * Закрепить хранилище, чтобы система не вычистила карту при нехватке места.
 *
 * Браузер решает сам и может отказать; молча считать отказ успехом нельзя —
 * тогда экран будет обещать сохранность, которой нет.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
