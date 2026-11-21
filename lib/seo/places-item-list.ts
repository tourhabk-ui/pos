/**
 * ItemList каталога мест (спецификация разметки Сыщика 21.11, §4.1): все места
 * из sitemap — канонические адреса /places/{slug}, не UUID (UUID отвечает 308),
 * у списка name, url и numberOfItems = длине массива. Тот же отбор, что у
 * sitemap (lib/seo/sitemap-entries): видимые, не слитые, без смотровых с
 * каноникалом на родителя.
 */
import { pool } from '@/lib/db-pool';
import { NOT_MERGED } from '@/lib/places/aliases';
import { placeInSitemap } from '@/lib/seo/h1-templates';

export interface PlaceListRow { name: string; slug: string | null; ark_id: string }

export function placesItemListJsonLd(rows: readonly PlaceListRow[], site: string): Record<string, unknown> {
  const items = rows.filter((r) => r.slug && placeInSitemap(r.slug));
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${site}/places#list`,
    name: 'Места Камчатки',
    url: `${site}/places`,
    numberOfItems: items.length,
    itemListElement: items.map((r, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: r.name,
      url: `${site}/places/${r.slug}`,
    })),
  };
}

export async function loadPlacesForItemList(): Promise<PlaceListRow[]> {
  const { rows } = await pool.query<PlaceListRow>(`
    SELECT name, slug, ark_id::text AS ark_id
      FROM places
     WHERE is_visible = TRUE
       AND slug IS NOT NULL
       AND ${NOT_MERGED('places')}
     ORDER BY name
     LIMIT 2000
  `);
  return rows;
}
