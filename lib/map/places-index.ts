/**
 * Указатель мест под картой /map — все видимые места, по типам (14.10).
 *
 * Перепись sitemap 12 (14.10): у /map в серверном HTML 12 слов — сама карта
 * рисуется в браузере, и поисковику на странице под запрос «карта Камчатки»
 * читать было нечего. Здесь те же места, что на карте, списком: у каждого —
 * ссылка на карточку.
 *
 * Условие видимости — то же, что у sitemap (lib/seo/sitemap-entries): ссылка
 * ведёт только на адрес, который отвечает 200 и сам стоит в sitemap. Слитое
 * место отвечает 308 на основное — его в указателе нет.
 */
import { pool } from '@/lib/db-pool';
import { NOT_MERGED } from '@/lib/places/aliases';
import { locationTypeLabel } from '@/lib/places/location-types';

export interface MapIndexPlace {
  name: string;
  href: string;
}

export interface MapIndexGroup {
  type: string;
  label: string;
  places: MapIndexPlace[];
}

export interface MapPlacesIndex {
  total: number;
  groups: MapIndexGroup[];
}

export interface MapIndexRow {
  ark_id: string;
  slug: string | null;
  name: string;
  location_type: string | null;
}

/** Места без типа и с типом `other` — одной группой, в конце списка. */
const OTHER = 'other';
const OTHER_LABEL = 'Другие места';

/** Группы по типу: больше мест — выше; внутри группы — по алфавиту. */
export function groupPlaces(rows: readonly MapIndexRow[]): MapPlacesIndex {
  const byType = new Map<string, MapIndexPlace[]>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const type = r.location_type || OTHER;
    const list = byType.get(type) ?? [];
    list.push({ name, href: `/places/${r.slug ?? r.ark_id}` });
    byType.set(type, list);
  }
  const groups = [...byType.entries()].map(([type, places]) => ({
    type,
    label: type === OTHER ? OTHER_LABEL : locationTypeLabel(type),
    places: places.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  }));
  groups.sort((a, b) => {
    if ((a.type === OTHER) !== (b.type === OTHER)) return a.type === OTHER ? 1 : -1;
    return b.places.length - a.places.length || a.label.localeCompare(b.label, 'ru');
  });
  return { total: groups.reduce((s, g) => s + g.places.length, 0), groups };
}

/** null — не смогли прочитать (§4.0): это не «мест нет», и отказ в логе. */
export async function loadMapPlacesIndex(): Promise<MapPlacesIndex | null> {
  try {
    const { rows } = await pool.query<MapIndexRow>(`
      SELECT ark_id, slug, name, location_type
      FROM places
      WHERE is_visible = TRUE
        AND ${NOT_MERGED('places')}
      LIMIT 2000
    `);
    return groupPlaces(rows);
  } catch (e) {
    console.error('[map] указатель мест не прочитан', {
      code: (e as { code?: string })?.code,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
