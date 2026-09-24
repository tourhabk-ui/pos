/**
 * Что из карты лежит в телефоне — и когда легло.
 *
 * Три требования офлайн-контракта: скачано до выхода, видно что скачано,
 * названо когда скачано. Первое — дело человека, второе и третье — наше.
 *
 * Запись живёт в localStorage рядом с самими тайлами в кэше service worker.
 * Разъехаться они могут (систему никто не спрашивает, когда она чистит кэш),
 * поэтому запись — не доказательство, а заявление: «мы скачали столько-то
 * тогда-то».
 *
 * До 20.09 этим всё и заканчивалось: экран планирования рисовал зелёную
 * галочку «Карта сохранена» прямо из записи, и вычищенный кэш узнавался уже
 * в поле. Теперь заявление проверяется делом — `lib/offline/coverage.ts`
 * спрашивает Cache Storage, сколько тайлов он отдаёт на самом деле.
 *
 * Проверке нужен список адресов. На экране планирования он приходит с
 * планом сервера, но чек-лист готовности читает запись сам, без плана, — и
 * без связи спросить было бы не о чем. Поэтому запись несёт СВОЮ пробу
 * (`sampleUrls`): маленькую, зато всегда при себе.
 *
 * Проба — не гарантия целости, и «проверить нечем» (нет Cache Storage,
 * старая запись без пробы) осталось отдельным исходом. Но «сохранено» без
 * карты больше не выдаётся за готовность.
 */

export interface SavedMapRecord {
  /** Когда скачали, мс. */
  at: number;
  tiles: number;
  mb: number;
  zooms: number[];
  /** Зумы, отброшенные потолком: карта есть, но грубее обещанной. */
  droppedZooms: number[];
  /**
   * Коридор по треку или квадрат вокруг точки (растровые тайлы, до 28.08) —
   * либо клетки своих пакетов целиком (с 24.09).
   */
  coverage: 'corridor' | 'bbox' | 'packs';
  bufferKm: number | null;
  /**
   * Закреплено ли хранилище. Без закрепления система вправе вычистить кэш при
   * нехватке места — без предупреждения и, по закону подлости, перед выходом.
   */
  persisted: boolean;
  /**
   * Проба адресов тайлов — чем проверить, что карта ещё на месте.
   *
   * Живёт в записи, а не считается заново: план коридора приходит с сервера,
   * и без связи пересчитать его нечем — то есть ровно тогда, когда проверка
   * нужнее всего. У записей, сделанных до 20.09, поля нет: пустая проба —
   * честное «проверить нечем», а не «карты нет».
   */
  sampleUrls: string[];
}

/**
 * Сколько адресов класть в пробу записи.
 *
 * Не 120, как берёт сплошная проверка покрытия: проба едет в localStorage и
 * живёт там до следующей закачки. Двух десятков хватает, чтобы заметить
 * вычищенный кэш и дырявую закачку, — а именно это решает, ставить ли
 * галочку готовности к выходу.
 */
export const SAVED_PROBE_SIZE = 24;

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
      coverage: d.coverage === 'bbox' ? 'bbox' : d.coverage === 'packs' ? 'packs' : 'corridor',
      bufferKm: typeof d.bufferKm === 'number' ? d.bufferKm : null,
      persisted: d.persisted === true,
      sampleUrls: Array.isArray(d.sampleUrls)
        ? (d.sampleUrls as unknown[]).filter((u): u is string => typeof u === 'string')
        : [],
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
  } else if (rec.coverage === 'packs') {
    parts.unshift('клетки карты вокруг маршрута целиком');
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
