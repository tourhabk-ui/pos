/**
 * Серверные хелперы страниц каталога туров (/catalog и /marketplace —
 * страницы-близнецы на одном клиенте): разбор deep-link параметров в фильтры
 * data-слоя и сборка ItemList JSON-LD из тех же данных, что идут в видимый
 * HTML (раньше JSON-LD собирался отдельным запросом, а видимый HTML был пуст).
 */

import { PRICE_RANGES } from '@/lib/tours/marketplace-constants';
import type { MarketplaceToursFilters, MarketplaceTourRow } from '@/lib/tours/marketplace-query';

const SORT_VALUES = ['recommended', 'price_asc', 'price_desc', 'recent'] as const;
const DIFFICULTY_VALUES = ['easy', 'medium', 'hard'] as const;
const DURATION_VALUES = ['day', 'half_day', 'multi_day'] as const;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export interface ParsedMarketplaceParams {
  filters: MarketplaceToursFilters;
  /** Ключ состояния клиента — гидрация без даблфетча (см. MarketplaceClient). */
  initialKey: string;
}

export function parseMarketplaceSearchParams(
  sp: Record<string, string | string[] | undefined>
): ParsedMarketplaceParams {
  const search = first(sp.search).slice(0, 200);
  const activityType = first(sp.activity_type).slice(0, 60);
  const sortRaw = first(sp.sort);
  const sort = (SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as MarketplaceToursFilters['sort'])
    : 'recommended';
  const difficultyRaw = first(sp.difficulty);
  const difficulty = (DIFFICULTY_VALUES as readonly string[]).includes(difficultyRaw)
    ? (difficultyRaw as 'easy' | 'medium' | 'hard')
    : undefined;
  const durationRaw = first(sp.duration_type);
  const durationType = (DURATION_VALUES as readonly string[]).includes(durationRaw)
    ? (durationRaw as 'day' | 'half_day' | 'multi_day')
    : undefined;
  const priceRaw = first(sp.price);
  const priceRange = PRICE_RANGES.find(r => r.value === priceRaw && r.value !== '');

  return {
    filters: {
      ...(search ? { search } : {}),
      ...(activityType ? { activity_type: activityType } : {}),
      sort,
      ...(difficulty ? { difficulty } : {}),
      ...(durationType ? { duration_type: durationType } : {}),
      ...(priceRange?.min != null ? { price_min: priceRange.min } : {}),
      ...(priceRange?.max != null ? { price_max: priceRange.max } : {}),
      limit: 50,
      offset: 0,
    },
    initialKey: JSON.stringify({
      search,
      activityFilter: activityType,
      sort,
      difficulty: difficulty ?? '',
      priceRange: priceRange?.value ?? '',
      durationType: durationType ?? '',
    }),
  };
}

export function buildToursItemListJsonLd(
  tours: MarketplaceTourRow[],
  site: string,
  basePath: '/catalog' | '/marketplace'
): object | null {
  if (tours.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Реальные туры по Камчатке',
    description: 'Каталог реальных туров по Камчатке от проверенных операторов',
    url: `${site}${basePath}`,
    numberOfItems: tours.length,
    itemListElement: tours.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'TouristTrip',
        '@id': `${site}${basePath}/tours/${t.id}`,
        name: t.title,
        description: t.description?.slice(0, 160) ?? undefined,
        ...(t.tour_image ? { image: t.tour_image } : {}),
        provider: {
          '@type': 'TouristInformationCenter',
          name: t.operator_name,
        },
        offers: {
          '@type': 'Offer',
          price: parseFloat(String(t.base_price)),
          priceCurrency: 'RUB',
          availability: 'https://schema.org/InStock',
          url: `${site}${basePath}/tours/${t.id}`,
        },
      },
    })),
  };
}
