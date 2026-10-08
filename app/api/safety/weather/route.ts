import { NextResponse } from 'next/server';
import { fetchForecastDays } from '@/lib/planner/intelligence';
import { DEFAULT_WEATHER_PLACE } from '@/lib/kuzmich/weather-tool';
import { WEATHER_PAGE_DAYS } from '@/lib/weather/weather-page';
import { safetyWeather } from '@/lib/weather/safety-widget';

/**
 * GET /api/safety/weather — погода в Петропавловске на экране безопасности.
 *
 * Источник — тот же прогноз, что у Кузьмича, сводки и /weather
 * (`fetchForecastDays`), а не wttr.in (решение владельца 08.10). Горизонт —
 * как у страницы погоды: запись кэша на три часа общая, и виджет не делает
 * своего запроса к Open-Meteo.
 *
 * `?fresh=1` здесь больше ничего не значит и не читается: прогноз меняется
 * раз в часы, к источнику на нажатие кнопки не ходим. Время в ответе —
 * момент получения прогноза (`checked_at`), старый прогноз помечен `stale`.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  // Отказ Open-Meteo fetchForecastDays пишет в лог сам.
  const f = await fetchForecastDays(DEFAULT_WEATHER_PLACE.lat, DEFAULT_WEATHER_PLACE.lng, WEATHER_PAGE_DAYS);
  if (!f.ok) {
    return NextResponse.json({ error: 'Прогноз погоды получить не удалось' }, { status: 502 });
  }
  const w = safetyWeather(f, DEFAULT_WEATHER_PLACE.name);
  if (!w) {
    console.error('[safety/weather] в прогнозе нет сегодняшнего дня', f.staleSince ?? f.fetchedAt ?? '');
    return NextResponse.json({ error: 'Прогноз на сегодня получить не удалось' }, { status: 502 });
  }
  return NextResponse.json(w);
}
