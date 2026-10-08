/**
 * План поездки на телефоне без сети (#2225): явное сохранение страницы
 * /trip/[token], её GPX и файлов страницы в свой кэш.
 *
 * Service worker и так кладёт открытый онлайн план в общий кэш, но с LRU на
 * десять страниц: открыл ещё десять планов — свой вытеснился молча, а надпись
 * под GPX («страница плана сохраняется на телефоне») продолжала это обещать.
 * Здесь — то, что человек сохранил сам: отдельный кэш, который не трогает ни
 * LRU, ни выкатка новой версии service worker'а (sw.js держит это имя в белом
 * списке активации, сторож сверяет равенство).
 *
 * Состояний у сохранения три, а не два (§4.0): сохранён; не сохранён;
 * сохранить здесь нельзя (нет Cache API, приватный режим, нет service
 * worker'а). Третье не прячется за кнопкой, которая ничего не сделает.
 */

/** Имя кэша — то же, что SAVED_TRIPS_CACHE_NAME в public/sw.js. */
export const SAVED_TRIPS_CACHE_NAME = 'kh-trips-saved-v1';

export function tripPagePath(token: string): string {
  return `/trip/${token}`;
}

export function tripGpxPath(token: string): string {
  return `/api/trips/share/${token}/gpx`;
}

/** Метка сохранения: когда и с какими файлами страницы. Сеть этот адрес не спрашивает никогда. */
export function tripMarkerPath(token: string): string {
  return `/__saved-trips/${token}`;
}

/**
 * Файлы страницы, без которых она откроется голым HTML без карты и кнопок:
 * чанки и стили Next своего домена. Чужие адреса (тайлы, счётчики) — мимо.
 */
export function pageAssetPaths(origin: string, candidates: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of candidates) {
    try {
      const u = new URL(raw, origin);
      if (u.origin === origin && u.pathname.startsWith('/_next/static/')) out.add(u.pathname + u.search);
    } catch {
      // Не адрес — не файл страницы; пропуск здесь и есть ответ.
    }
  }
  return [...out].sort();
}

export type OfflineStatus =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not_saved' }
  | { kind: 'saved'; savedAt: string | null };

export interface OfflineDeps {
  caches: CacheStorage | undefined;
  fetch: typeof fetch;
}

interface Marker { savedAt: string; assets: string[] }

/**
 * Метка — три исхода (§4.0): есть; нет; битая. Битая — не «пустая метка»:
 * пустая разрешила бы уборке удалить файлы плана, о котором ничего не
 * известно, — с ней уборка не идёт вовсе.
 */
type MarkerRead = { kind: 'ok'; marker: Marker } | { kind: 'absent' } | { kind: 'broken' };

async function readMarker(cache: Cache, path: string): Promise<MarkerRead> {
  const res = await cache.match(path);
  if (!res) return { kind: 'absent' };
  try {
    const j = await res.json() as Partial<Marker>;
    return {
      kind: 'ok',
      marker: {
        savedAt: typeof j.savedAt === 'string' ? j.savedAt : '',
        assets: Array.isArray(j.assets) ? j.assets.filter((a): a is string => typeof a === 'string') : [],
      },
    };
  } catch {
    // План лежит, но когда и с какими файлами сохранён — неизвестно.
    return { kind: 'broken' };
  }
}

export async function readOfflineStatus(token: string, deps: OfflineDeps): Promise<OfflineStatus> {
  if (!deps.caches) return { kind: 'unavailable', reason: 'в этом браузере нет офлайн-хранилища' };
  try {
    const cache = await deps.caches.open(SAVED_TRIPS_CACHE_NAME);
    if (!(await cache.match(tripPagePath(token)))) return { kind: 'not_saved' };
    const marker = await readMarker(cache, tripMarkerPath(token));
    return { kind: 'saved', savedAt: marker.kind === 'ok' ? (marker.marker.savedAt || null) : null };
  } catch {
    return { kind: 'unavailable', reason: 'браузер не дал доступ к хранилищу — так бывает в приватном режиме' };
  }
}

export type SaveResult =
  | { ok: true; savedAt: string; gpx: boolean; assets: number; assetsFailed: number }
  | { ok: false; reason: string };

/**
 * Удалить из кэша файлы страниц, на которые не ссылается ни одна метка: имя
 * чанка меняется с каждой сборкой, и без уборки кэш сохранённых планов копил
 * бы чанки всех выкаток подряд — тот же рост без потолка, что был у статики
 * service worker'а до 13.09.
 */
async function pruneAssets(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  const keep = new Set<string>();
  for (const req of keys) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/__saved-trips/')) continue;
    const m = await readMarker(cache, path);
    // На что ссылается битая метка, неизвестно — значит, удалять нельзя ничего.
    if (m.kind === 'broken') return;
    if (m.kind === 'ok') for (const a of m.marker.assets) keep.add(a);
  }
  await Promise.all(keys
    .filter((req) => {
      const u = new URL(req.url);
      return u.pathname.startsWith('/_next/static/') && !keep.has(u.pathname + u.search);
    })
    .map((req) => cache.delete(req)));
}

export async function saveTripOffline(
  token: string,
  assetPaths: readonly string[],
  deps: OfflineDeps,
  now: Date = new Date(),
): Promise<SaveResult> {
  if (!deps.caches) return { ok: false, reason: 'в этом браузере нет офлайн-хранилища' };
  try {
    const cache = await deps.caches.open(SAVED_TRIPS_CACHE_NAME);

    // Страница — без неё сохранять нечего. Берётся из сети, а не из общего
    // кэша: сохранённая копия должна быть свежей правкой плана.
    const page = await deps.fetch(tripPagePath(token), { cache: 'no-store' });
    if (!page.ok) {
      return {
        ok: false,
        reason: page.status === 404
          ? 'план не найден — ссылка неверна или ей больше 7 дней'
          : `страница плана ответила ошибкой ${page.status}, попробуйте позже`,
      };
    }
    await cache.put(tripPagePath(token), page);

    // GPX — по возможности: у плана без координат его нет (404), и это не отказ.
    let gpx = false;
    try {
      const g = await deps.fetch(tripGpxPath(token), { cache: 'no-store' });
      if (g.ok) { await cache.put(tripGpxPath(token), g); gpx = true; }
    } catch {
      gpx = false; // сеть моргнула на GPX — страница сохранена, GPX нет; сказано в итоге
    }

    // Файлы страницы: без них откроется текст плана без карты и кнопок.
    let assets = 0;
    let assetsFailed = 0;
    const saved: string[] = [];
    for (const path of assetPaths) {
      try {
        const r = await deps.fetch(path);
        if (r.ok) { await cache.put(path, r); assets++; saved.push(path); } else { assetsFailed++; }
      } catch {
        assetsFailed++;
      }
    }

    const savedAt = now.toISOString();
    await cache.put(tripMarkerPath(token), new Response(JSON.stringify({ savedAt, assets: saved }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await pruneAssets(cache);
    return { ok: true, savedAt, gpx, assets, assetsFailed };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'QuotaExceededError') return { ok: false, reason: 'на телефоне не хватило места' };
    return { ok: false, reason: `не удалось записать${name ? ` (${name})` : ''}` };
  }
}

export async function removeTripOffline(token: string, deps: OfflineDeps): Promise<boolean> {
  if (!deps.caches) return false;
  try {
    const cache = await deps.caches.open(SAVED_TRIPS_CACHE_NAME);
    await Promise.all([tripPagePath(token), tripGpxPath(token), tripMarkerPath(token)].map((p) => cache.delete(p)));
    await pruneAssets(cache);
    return true;
  } catch {
    return false;
  }
}
