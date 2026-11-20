/**
 * Разметка карточки парка: Park + TouristAttraction. Только поля из базы:
 * координат у справочника parks нет (миграция 712) — geo не ставится, а не
 * выдумывается.
 */
import type { ParkPageData } from '@/lib/parks/park-page';

export function parkJsonLd(p: Pick<ParkPageData, 'slug' | 'displayName' | 'description'>, site: string): Record<string, unknown> {
  const url = `${site}/park/${p.slug}`;
  const description = (p.description ?? '').replace(/\s+/g, ' ').trim();
  return {
    '@context': 'https://schema.org',
    '@type': ['Park', 'TouristAttraction'],
    // @id — чтобы узел WebPage (dateModified) сослался на парк как mainEntity.
    '@id': `${url}#park`,
    name: p.displayName,
    url,
    ...(description ? { description } : {}),
    containedInPlace: { '@type': 'AdministrativeArea', name: 'Камчатский край' },
  };
}
