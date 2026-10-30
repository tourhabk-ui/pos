/**
 * Движок ПОИСК — единая точка входа для поиска и подбора туров.
 *
 * Консолидация (июль 2026): раньше поиск туров был размазан по
 * `lib/tours/marketplace-query` и `lib/recommendations/engine`. Сведено сюда:
 *   - tour-search    — фильтр-поиск публичного каталога туров (operator_tours);
 *   - tour-recommend — персональные рекомендации (3 стратегии + кэш);
 *   - tour-match     — где в полях тура стоит слово туриста (фильтр get_tours
 *                      у Кузьмича и MCP; своего подбора у Кузьмича нет).
 *
 * Поиск маршрутов/мест (не туров) живёт отдельно в `lib/routes/catalog-query`
 * — другой домен (kamchatka_routes / places), сознательно не сливаем.
 */

export {
  MarketplaceToursQuerySchema,
  queryMarketplaceTours,
  queryMarketplaceToursForPage,
  queryCatalogSummary,
  queryCatalogSummaryForPage,
  summarizeCatalogRows,
  type CatalogSummary,
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

// Упоминает ли тур слово туриста (ловушка MCP 29.10, filter-coverage): поля
// тура, а не строка каталога с именем компании. Читают фильтр get_tours и
// туры места у search_transfers (lib/kuzmich).
export {
  tourMatchEntry,
  parseTourQuery,
  matchTour,
  matchTourPlace,
  tourTextSearchable,
  onlyGenericTourWords,
  normalizeMatchText,
  MIN_QUERY_WORD,
  TOUR_GENERIC_WORDS,
  type TourMatch,
  type TourMatchEntry,
  type TourMatchRow,
  type TourQuery,
} from './tour-match';

// Основа слова и английский словарь — общие с search коннектора (lib/mcp/search-terms).
export { stemRu, translateEn, EN_TO_RU, QUERY_STOP_WORDS, SHORT_STEMS, SHORT_STEMS_NOT_SEARCHED } from './query-words';
