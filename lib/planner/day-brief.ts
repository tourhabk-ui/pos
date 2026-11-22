/**
 * «В поездке»: сегодня и завтра одной сводкой (фича 4 супер-планера, 23.11).
 *
 * Чистая функция: из дней плана, даты прилёта и камчатской даты «сегодня»
 * собирает, что показать сверху страницы плана. Только то, что план уже
 * несёт: заголовок и зона дня, прогноз дня (если он в пределах прогноза),
 * «что взять», предупреждения дня (закрытия парков, МЧС — от движка), запасные
 * туры на непогоду. Ничего не угадывает: нет прогноза — нет строки погоды.
 * Наличие мест здесь не читается и не кэшируется.
 *
 * Сторож: tests/unit/planner-day-brief.test.ts.
 */
import { planDayDate } from './day-tour-link';

export interface BriefWeather {
  tempMin: number;
  tempMax: number;
  description?: string | null;
  windKmh?: number;
  precipMm?: number;
  /** Погода, при которой зависящий от погоды тур могут отменить (share-API). */
  bad?: boolean;
}

export interface BriefDayInput {
  day: number;
  title: string;
  zone?: string | null;
  dayWarnings?: readonly string[];
  weather?: BriefWeather | null;
  /** «Что взять» по прогнозу (lib/planner/weather-kit). */
  kit?: string | null;
  /** Запасные туры на непогоду — названия. */
  planB?: readonly string[];
  weatherDependent?: boolean;
}

export interface BriefItem {
  label: 'Сегодня' | 'Завтра';
  date: string;
  day: BriefDayInput;
  weatherLine: string | null;
  /** Тур зависит от погоды и прогноз плохой — человеку сказать прямо. */
  weatherRisk: boolean;
  /** Совет «что взять» без повтора прогноза. */
  advice: string | null;
}

export type TripBrief =
  | { state: 'no_dates' | 'after' }
  | { state: 'before'; daysLeft: number }
  | { state: 'during'; items: BriefItem[] };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`;

export function briefWeatherLine(w: BriefWeather | null | undefined): string | null {
  if (!w || !Number.isFinite(w.tempMin) || !Number.isFinite(w.tempMax)) return null;
  const parts = [`${signed(w.tempMin)}…${signed(w.tempMax)} °C`];
  const desc = w.description?.trim().toLowerCase();
  if (desc) parts.push(desc);
  if (Number.isFinite(w.windKmh) && (w.windKmh as number) >= 30) parts.push(`ветер ${Math.round(w.windKmh as number)} км/ч`);
  if (Number.isFinite(w.precipMm) && (w.precipMm as number) >= 1) parts.push(`осадки ${Math.round(w.precipMm as number)} мм`);
  return parts.join(', ');
}

/**
 * Совет «что взять» без повтора прогноза: строка weather-kit начинается с
 * «Прогноз для зоны дня: …» — погода уже стоит своей строкой, остаётся совет.
 */
export function kitAdvice(kit: string | null | undefined): string | null {
  const t = kit?.trim();
  if (!t) return null;
  const i = t.indexOf('Возьмите');
  if (i >= 0) return t.slice(i);
  return /^Прогноз для зоны дня:/.test(t) ? null : t;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Сводка на сегодня/завтра. `today` — камчатская дата (kamchatkaDate).
 * Номер дня календарный: день N — дата прилёта + (N − 1).
 */
export function tripBrief(days: readonly BriefDayInput[], arrival: string | null | undefined, today: string): TripBrief {
  if (!arrival || !ISO.test(arrival) || !ISO.test(today) || days.length === 0) return { state: 'no_dates' };
  const offset = daysBetween(arrival, today);
  const last = Math.max(...days.map((d) => d.day));
  if (offset < 0) return { state: 'before', daysLeft: -offset };
  if (offset + 1 > last) return { state: 'after' };
  const items: BriefItem[] = [];
  for (const [label, n] of [['Сегодня', offset + 1], ['Завтра', offset + 2]] as const) {
    const day = days.find((d) => d.day === n);
    if (!day) continue;
    items.push({
      label,
      date: planDayDate(arrival, n - 1),
      day,
      weatherLine: briefWeatherLine(day.weather),
      weatherRisk: Boolean(day.weatherDependent && day.weather?.bad),
      advice: kitAdvice(day.kit),
    });
  }
  return { state: 'during', items };
}
