/**
 * Прогноз на завтра для напоминания о туре (`/api/cron/tour-reminder`).
 */
import { fetchForecastDays, type ForecastDay } from '@/lib/planner/intelligence';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

/** Точка прогноза напоминания — Петропавловск, как до перевода на общий прогноз. */
export const REMINDER_POINT = { lat: 53.01, lng: 158.65 } as const;

/**
 * Прогноз на завтра для напоминания — общий прогноз платформы
 * (`fetchForecastDays`: осадки из GFS, остальное из сводной модели, кэш,
 * склейка одновременных запросов, запас на 429). До 29.10 (#2289) здесь был
 * свой запрос к Open-Meteo со сводной моделью для осадков, а отказ глушился
 * пустым `catch` — «прогноза нет» и «прогноз не пришёл» были неотличимы.
 *
 * Точка — Петропавловск, как и раньше; завтра — второй день прогноза (день
 * Open-Meteo считается по Камчатке). Пропуск в прогнозе не становится нулём:
 * нет осадков или ветра — нет и слова о них (§4.0). Пустая строка — прогноза
 * нет, причина уже в логе.
 */
export async function fetchWeatherForReminder(): Promise<string> {
  try {
    const f = await fetchForecastDays(REMINDER_POINT.lat, REMINDER_POINT.lng, 2);
    if (!f.ok) {
      // Сырую причину fetchForecastDays уже записал; здесь — кто остался без прогноза.
      logSwallowedFailure('tour-reminder', 'прогноз на завтра', new Error(f.reason));
      return '';
    }
    const d = f.days[1];
    if (!d) {
      logSwallowedFailure('tour-reminder', 'прогноз на завтра', new Error(`в прогнозе ${f.days.length} дн., завтрашнего нет`));
      return '';
    }
    return reminderWeatherLine(d);
  } catch (err) {
    logSwallowedFailure('tour-reminder', 'прогноз на завтра', err);
    return '';
  }
}

/** Строка прогноза для промпта: только то, что в прогнозе есть. */
export function reminderWeatherLine(d: ForecastDay): string {
  const parts: string[] = [];
  if (d.tempMin !== null && d.tempMax !== null) parts.push(`${d.tempMin}–${d.tempMax}°C`);
  if (d.weatherCode !== null) parts.push(weatherCodeDesc(d.weatherCode));
  if (d.precipMm !== null) parts.push(`осадки ${d.precipMm} мм`);
  if (d.windKmh !== null) parts.push(`ветер до ${d.windKmh} км/ч`);
  if (parts.length === 0) return '';
  return `Петропавловск-Камчатский завтра: ${parts.join(', ')}.`;
}

function weatherCodeDesc(code: number): string {
  if (code === 0) return 'ясно';
  if (code <= 3) return 'переменная облачность';
  if (code <= 48) return 'туман';
  if (code <= 57) return 'морось';
  if (code <= 67) return 'дождь';
  if (code <= 77) return 'снег';
  if (code <= 82) return 'ливень';
  if (code <= 99) return 'гроза';
  return 'переменная погода';
}
