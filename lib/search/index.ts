/**
 * Движок ПОИСК — единая точка входа для поиска и подбора туров.
 *
 * Консолидация (июль 2026): раньше поиск туров был размазан по
 * `lib/tours/marketplace-query` и `lib/recommendations/engine`. Сведено сюда:
 *   - tour-search    — фильтр-поиск публичного каталога туров (operator_tours);
 *   - tour-recommend — персональные рекомендации (3 стратегии + кэш).
 *
 * Поиск маршрутов/мест (не туров) живёт отдельно в `lib/routes/catalog-query`
 * — другой домен (kamchatka_routes / places), сознательно не сливаем.
 */

export {
  MarketplaceToursQuerySchema,
  queryMarketplaceTours,
  queryMarketplaceToursForPage,
  type MarketplaceToursFilters,
  type MarketplaceTourRow,
  type MarketplaceToursResult,
} from './tour-search';

export {
  getRecommendations,
  getCachedRecommendations,
  saveRecommendationsCache,
  type RecommendationStrategy,
  type RecommendedTour,
} from './tour-recommend';
