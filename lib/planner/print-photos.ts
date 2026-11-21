/**
 * Снимки туров для PDF плана (макет 21.11): обложка и превью в программе —
 * только кадры с подписью автора (`imageCaptions` у /api/tours/[id]). Кадра
 * с автором нет — снимка нет: чужое фото без подписи в документ не идёт.
 * Не прочиталось за отведённое время — документ остаётся без снимков.
 */
import type { PrintPhoto } from '@/lib/planner/print-html';

export const PRINT_PHOTOS_MAX_TOURS = 4;
export const PRINT_PHOTOS_TIMEOUT_MS = 2500;

/** Первый кадр с подписью автора из ответа /api/tours/[id]; нет — null. */
export function creditedPhoto(data: unknown): PrintPhoto | null {
  const d = data as { images?: unknown; imageCaptions?: unknown } | null;
  const images = Array.isArray(d?.images) ? d!.images : [];
  const caps = Array.isArray(d?.imageCaptions) ? d!.imageCaptions : [];
  for (let i = 0; i < images.length; i++) {
    const src = images[i];
    const caption = caps[i];
    if (typeof src !== 'string' || typeof caption !== 'string' || !caption.trim()) continue;
    if (!(src.startsWith('/') && !src.startsWith('//')) && !/^https:\/\//.test(src)) continue;
    return { src, caption: caption.trim() };
  }
  return null;
}

export async function loadPrintPhotos(
  tourIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, PrintPhoto>> {
  const ids = [...new Set(tourIds)].slice(0, PRINT_PHOTOS_MAX_TOURS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRINT_PHOTOS_TIMEOUT_MS);
  try {
    const pairs = await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetchImpl(`/api/tours/${encodeURIComponent(id)}`, { signal: ctrl.signal });
        if (!r.ok) return null;
        const j = await r.json() as { success?: boolean; data?: unknown };
        const p = j?.success ? creditedPhoto(j.data) : null;
        return p ? [id, p] as const : null;
      } catch {
        return null;
      }
    }));
    return Object.fromEntries(pairs.filter((x): x is readonly [string, PrintPhoto] => x !== null));
  } finally {
    clearTimeout(timer);
  }
}
