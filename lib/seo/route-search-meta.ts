/**
 * Заголовок и описание отдельных маршрутов под запросы Google
 * (Search Console 18–20.11: топ-10 без кликов). Факты — только из карточки
 * маршрута. Без « | Ведар»: его добавляет brandedTitle; вместе title ≤ 60,
 * description ≤ 160.
 */
export interface RouteSearchMeta {
  title: string;
  description: string;
}

export const ROUTE_SEARCH_META: Readonly<Record<string, RouteSearchMeta>> = {
  // «Мыс Лопатка» — 11 показов в топ-10, 0 кликов. Автозаголовок с набором
  // и «сложность лёгкая» выходил за 60 знаков и не отражал текст карточки:
  // прибрежный рельеф, неустойчивая погода, импортированная линия.
  'mys-lopatka': {
    title: 'Мыс Лопатка: трек 2,7 км на юге Камчатки',
    description:
      'Маршрут 2,7 км к мысу Лопатка на юге Камчатки: прибрежный рельеф и неустойчивая погода даже летом. Линия маршрута импортирована, на месте не подтверждена.',
  },
};

export function routeSearchMeta(slug: string | null | undefined): RouteSearchMeta | null {
  return slug ? ROUTE_SEARCH_META[slug] ?? null : null;
}
