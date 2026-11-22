/**
 * Вход «Подробной программы» (/api/planner/itinerary) приходит из браузера —
 * ему нельзя верить как источнику того, что уходит в зарубежную модель.
 * Сведения о здоровье (особая категория ПД, решение владельца 26.09) не
 * должны туда попасть ни в виде наших предупреждений, ни подставленным
 * текстом (ревью безопасности #3743, два захода):
 *  — предупреждения берутся только безопасных типов: `fitness`, `safety`,
 *    `seasickness` — те, что выводятся из подвижности/самочувствия, — не идут;
 *  — любое предупреждение, заголовок дня, пометка цены, оператор или погода со словами о
 *    здоровье отбрасывается целиком (заголовок заменяется нейтральным).
 */
export const ITINERARY_WARNING_TYPES = [
  'permit', 'season', 'children', 'duration', 'weather', 'license', 'crowd',
  'mchs', 'zone_days', 'home_nights', 'tour_dates', 'dates',
] as const;
const SAFE_TYPES = new Set<string>(ITINERARY_WARNING_TYPES);

/** Слова о здоровье и подвижности. Ложное срабатывание стоит одной строки в промпте — не страшно. */
export const HEALTH_WORDS = /подвижн|коляск|безбарьер|инвалид|здоров|болезн|болит|больн|диагноз|астм|диабет|сердц|давлени|беремен|аллерг|травм|колен|спин[аеуы]|операци|лекарств|укачива|морск\w* болезн|эпилеп|онко|ограничени\w* по здоровью/i;

type W = { type: string; severity: string; message: string };
type D = { title: string; priceMissing?: string; realTour?: { operatorName: string }; weatherForecast?: { description: string } } & Record<string, unknown>;

export function scrubItineraryInput<Day extends D, Warn extends W>(days: Day[], warnings: Warn[]): { days: Day[]; warnings: Warn[] } {
  return {
    warnings: warnings.filter((w) => SAFE_TYPES.has(w.type) && !HEALTH_WORDS.test(w.message)),
    days: days.map((d) => {
      const out = { ...d };
      if (HEALTH_WORDS.test(d.title)) out.title = `День ${String(d.day ?? '')}`.trim();
      if (d.priceMissing && HEALTH_WORDS.test(d.priceMissing)) delete out.priceMissing;
      if (d.realTour && HEALTH_WORDS.test(d.realTour.operatorName)) delete out.realTour;
      if (d.weatherForecast && HEALTH_WORDS.test(d.weatherForecast.description)) delete out.weatherForecast;
      return out;
    }),
  };
}
