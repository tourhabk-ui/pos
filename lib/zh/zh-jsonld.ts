/**
 * Разметка китайских страниц туров и каталога (спецификация Сыщика 21.11,
 * §4.4, §4.7, §4.8): TouristTrip + Offer, BreadcrumbList, ItemList.
 * Только то, что показано на самой китайской странице: цена в рублях — она
 * стоит в фактах карточки (priceZh); наличие мест не пишется вовсе (его нет
 * на странице, и оно не кэшируется в разметке); FAQPage не ставится — у
 * китайской карточки нет блока вопросов.
 */
import type { ZhTourSourceRow } from '@/lib/zh/content';

const ZH_HOME = '首页';
const ZH_TOURS = '团队游';

export function zhBreadcrumbJsonLd(site: string, items: ReadonlyArray<{ name: string; path: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ name: ZH_HOME, path: '/zh' }, ...items].map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: it.name, item: `${site}${it.path}`,
    })),
  };
}

export function zhCatalogBreadcrumbJsonLd(site: string): Record<string, unknown> {
  return zhBreadcrumbJsonLd(site, [{ name: ZH_TOURS, path: '/zh/catalog' }]);
}

export function zhTourJsonLd(
  site: string,
  tour: Pick<ZhTourSourceRow, 'title' | 'base_price' | 'season_start' | 'season_end' | 'operator_name'>,
  path: string,
  name: string,
): Record<string, unknown>[] {
  const url = `${site}${path}`;
  const price = Number(tour.base_price);
  const trip: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    '@id': `${url}#trip`,
    name,
    url,
    inLanguage: 'zh-CN',
    provider: { '@type': 'Organization', name: tour.operator_name },
  };
  if (Number.isFinite(price) && price > 0) {
    trip.offers = {
      '@type': 'Offer',
      url,
      price: String(price),
      priceCurrency: 'RUB',
      ...(tour.season_start ? { validFrom: tour.season_start } : {}),
      ...(tour.season_end ? { validThrough: tour.season_end } : {}),
    };
  }
  return [
    trip,
    zhBreadcrumbJsonLd(site, [{ name: ZH_TOURS, path: '/zh/catalog' }, { name, path }]),
  ];
}

export function zhCatalogItemListJsonLd(site: string, tours: ReadonlyArray<{ path: string; name: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${site}/zh/catalog#list`,
    name: '堪察加团队游',
    url: `${site}/zh/catalog`,
    numberOfItems: tours.length,
    itemListElement: tours.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, url: `${site}${t.path}` })),
  };
}

/**
 * TouristAttraction китайского конспекта места (повторный аудит Сыщика 21.11,
 * §4.8). Только то, что стоит на странице: имя (китайское — из OSM name:zh,
 * иначе русское с пометкой), координаты из базы, описание — лишь перевод,
 * сделанный с нынешнего текста; устаревшего перевода в разметке нет.
 * sameAs — русская карточка того же места.
 */
export function zhPlaceJsonLd(
  site: string,
  place: { name: string; lat: string | null; lng: string | null },
  path: string,
  ruPath: string,
  name: string,
  freshDescription: string | null,
): Record<string, unknown> {
  const url = `${site}${path}`;
  const lat = place.lat == null ? NaN : Number(place.lat);
  const lng = place.lng == null ? NaN : Number(place.lng);
  return {
    '@context': 'https://schema.org',
    '@type': 'TouristAttraction',
    '@id': `${url}#place`,
    name,
    url,
    inLanguage: 'zh-CN',
    sameAs: `${site}${ruPath}`,
    ...(freshDescription ? { description: freshDescription } : {}),
    ...(Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
      ? { geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng } }
      : {}),
  };
}
