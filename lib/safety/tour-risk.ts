/**
 * Классификатор риска тура — чистая детерминированная функция (без БД/сети).
 *
 * Зачем: перед высокорисковым туром (восхождение на вулкан, вертолётная
 * заброска, рафтинг, зимний выход) турист обязан осознанно подтвердить риски и
 * задекларировать здоровье — это свойство безопасности платформы (§7 vedar),
 * а не формальность. «Высокий риск» определяется здесь ОДНИМ местом, чтобы
 * форма, API и PDF судили одинаково. Значения — реальные из operator_tours
 * (difficulty: easy/medium/moderate/hard/difficult/extreme/expert;
 * activity_type: volcano/helicopter/rafting/trekking/winter_hiking/…).
 */

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

// Сложность, при которой нужен вейвер: серьёзная физнагрузка + удалённость.
const HIGH_RISK_DIFFICULTY = new Set(['hard', 'difficult', 'extreme', 'expert']);

// Виды активности, опасные по своей природе независимо от «сложности»:
// падение/лавина/утопление/удалённость без быстрой эвакуации.
const HIGH_RISK_ACTIVITY = new Set([
  'volcano', 'helicopter', 'heli', 'rafting', 'mountaineering', 'alpine',
  'ski', 'skiing', 'ski_touring', 'skitour', 'winter_hiking', 'ice', 'ice_climbing',
  'diving', 'canyoning',
]);

/** Нужен ли подписанный вейвер для тура с такой сложностью/активностью. */
export function isHighRiskTour(
  difficulty: string | null | undefined,
  activityType: string | null | undefined,
): boolean {
  return HIGH_RISK_DIFFICULTY.has(norm(difficulty)) || HIGH_RISK_ACTIVITY.has(norm(activityType));
}

const ACTIVITY_REASON: Record<string, string> = {
  volcano: 'восхождение на вулкан',
  helicopter: 'вертолётная заброска',
  heli: 'вертолётная заброска',
  rafting: 'сплав по реке',
  mountaineering: 'альпинизм',
  alpine: 'альпинизм',
  ski: 'горные лыжи',
  skiing: 'горные лыжи',
  ski_touring: 'ски-тур',
  skitour: 'ски-тур',
  winter_hiking: 'зимний выход',
  ice: 'лёд',
  ice_climbing: 'ледолазание',
  diving: 'дайвинг',
  canyoning: 'каньонинг',
};

/**
 * Короткая причина высокого риска (для UI/PDF) на русском, либо null если тур
 * не высокорисковый. Приоритет — у вида активности (конкретнее), затем сложность.
 */
export function highRiskReason(
  difficulty: string | null | undefined,
  activityType: string | null | undefined,
): string | null {
  const act = norm(activityType);
  if (HIGH_RISK_ACTIVITY.has(act)) return ACTIVITY_REASON[act] ?? 'опасный вид активности';
  if (HIGH_RISK_DIFFICULTY.has(norm(difficulty))) return 'высокая сложность маршрута';
  return null;
}
