/**
 * Место, на котором открыть карту по ссылке (`/map?place=…`,
 * `lib/map/map-target.ts`).
 *
 * Только то, что нужно, чтобы поставить карту и открыть лист места: id,
 * название, тип и записанная координата. Опасности лист места берёт сам из
 * `/api/places/[id]` — один источник с карточкой места.
 *
 * Три исхода (§4.0): место найдено; не найдено (нет такого, скрыто, слито или
 * без координаты — «на глаз» точку не ставим); не загрузилось (отказ базы —
 * в лог с SQLSTATE). Страница в каждом случае открывает карту и говорит, что
 * с местом.
 */
import { query } from '@/lib/database';
import type { MapFocus } from '@/lib/map/map-target';

export type { MapFocus, MapFocusPlace } from '@/lib/map/map-target';

/**
 * По id, ark_id или slug — как страница места. Слитое место и место без
 * координаты не отдаются: точку без записанной координаты карта не рисует.
 */
export const MAP_FOCUS_SQL = `
  SELECT COALESCE(p.ark_id::text, p.id::text) AS id,
         p.name AS title,
         p.location_type,
         p.lat::float8 AS lat,
         p.lng::float8 AS lng
    FROM places p
   WHERE (p.ark_id::text = $1 OR p.id::text = $1 OR p.slug = $1)
     AND p.is_visible = true
     AND p.merged_into_id IS NULL
     AND p.lat IS NOT NULL
     AND p.lng IS NOT NULL
   LIMIT 1`;

const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function loadMapFocus(ref: string): Promise<MapFocus> {
  try {
    const { rows } = await query(MAP_FOCUS_SQL, [ref]);
    const r = rows[0] as Record<string, unknown> | undefined;
    const lat = finite(r?.lat);
    const lng = finite(r?.lng);
    if (!r || typeof r.id !== 'string' || typeof r.title !== 'string' || lat === null || lng === null) {
      return { state: 'not_found' };
    }
    return {
      state: 'place',
      place: {
        id: r.id,
        title: r.title,
        locationType: typeof r.location_type === 'string' ? r.location_type : null,
        lat,
        lng,
      },
    };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : 'unknown';
    console.error('[map-focus] место по ссылке не загрузилось, SQLSTATE', code);
    return { state: 'failed' };
  }
}
