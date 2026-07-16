/**
 * Движок ПЛАНЕР — единая точка входа для подбора и планирования поездки.
 *
 * Консолидация (июль 2026): раньше логика планирования была размазана по
 * `lib/services/{trip-recommender,planner-data-layer,planner-intelligence,
 * routes-recommender}`. Сведено в один модуль:
 *   - engine       — ядро подбора маршрута по дням (recommendTrip, зоны, граф);
 *   - compose      — сборка комплексного маршрута из нескольких туров (Кузьмич);
 *   - data         — data-слой (честная занятость, туры зоны, альтернативы);
 *   - intelligence — погода Open-Meteo, quality/health-скоринг;
 *   - interests    — парсинг интересов туриста → подбор маршрутов.
 *
 * Кузьмич (поверхность) зовёт этот движок, своего подбора не держит.
 */

export {
  recommendTrip,
  type TripProfile,
  type TripRecommendation,
  type DayPlan,
  type TripWarning,
  type PriceBreakdown,
  type ZoneId,
  type TransportType,
  type FitnessLevel,
  type BudgetTier,
} from './engine';

export {
  parseInterestsFromText,
  findRoutesByInterests,
  filterBySeasonality,
  formatRoutesForTelegram,
  SEASON_BLOCKED,
  type ParsedInterests,
  type RouteResult,
} from './interests';

export {
  fetchWeatherForecast,
  computeQualityScore,
  assessHealthCompatibility,
  type DayForecast,
  type HealthAssessment,
} from './intelligence';

export {
  createPlannerCache,
  fetchRealToursForZone,
  fetchAvailabilityForTour,
  fetchZoneCapacity,
  fetchContingencyAlternatives,
  fetchReviewSignals,
  type PlannerCache,
  type RealTour,
} from './data';

export {
  composeTrip,
  type ComposedTrip,
  type ComposeTripParams,
  type TripTour,
  type TripDay,
} from './compose';
