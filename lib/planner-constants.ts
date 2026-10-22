/**
 * Planner constants — single source of truth.
 * Used by: trip-recommender, planner chat, tourist-agency, PlannerClient.
 */

export const PLANNER_PLACE_IDS = [
  'volcano', 'hot_spring', 'geyser', 'sea', 'mountain', 'river',
] as const;

export const PLANNER_ACTIVITY_IDS = [
  'trekking', 'fishing', 'helicopter', 'bears', 'snowmobile', 'boat_trip', 'rafting',
] as const;

export type PlannerPlaceId = typeof PLANNER_PLACE_IDS[number];
export type PlannerActivityId = typeof PLANNER_ACTIVITY_IDS[number];

/** Map legacy/recommender names to canonical place IDs */
export const RECOMMENDER_TO_PLACES: Record<string, string> = {
  thermal: 'hot_spring',
};

// Зоны здесь больше не живут (22.10): копия словаря зон — имена, цвета-токены,
// центры, транспорт и пресеты значков Яндекс-карт — не имела ни одного
// читателя и расходилась с движком. Зоны — lib/planner/constants (ZONE_NAMES),
// их цвет и имя на карте — lib/planner/zone-style.

export const ACTIVITY_LABEL: Record<string, string> = {
  trekking:   'Треккинг',
  fishing:    'Рыбалка',
  helicopter: 'Вертолёт',
  bears:      'Медведи',
  snowmobile: 'Снегоходы',
  rafting:    'Сплав',
  boat_trip:  'Морской тур',
  volcano:    'Вулкан',
  hot_spring: 'Термальные',
  geyser:     'Гейзеры',
  sea:        'Побережье',
  mountain:   'Горы',
  river:      'Реки',
};

/** SEA-related activity types (affected by seasickness) */
export const SEA_ACTIVITIES = new Set(['boat_trip', 'sea', 'fishing']);

/** Activities requiring high physical fitness */
export const HARD_ACTIVITIES = new Set(['volcano', 'mountain', 'trekking']);
