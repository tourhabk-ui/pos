/**
 * Типы и адрес виджета погоды главной — без серверных импортов: их читает
 * клиентский компонент (components/homepage/HomeWeatherStrip). Правила и
 * загрузка — lib/weather/home-widget (сервер).
 *
 * Числа приходят уже строками («+4», «−1»): правило записи температуры одно —
 * fmtTemp из weather-format, и в браузере его второй раз не заводят.
 */
import type { WeatherSky } from '@/lib/weather/sky';

export interface HomeWeatherDay {
  date: string;
  /** «Пт» — день недели коротко, по дате прогноза. */
  weekday: string;
  code: number | null;
  /** «+6»; null — источник не дал. */
  max: string | null;
  min: string | null;
}

export interface HomeWeatherWarning {
  count: number;
  /** Самое серьёзное: «Ветер — жёлтый уровень (юг края)». */
  title: string;
  severity: 1 | 2 | 3;
}

export type HomeWeather =
  | {
      kind: 'ok';
      place: string;
      /** «+4»; null — температуры в прогнозе нет. */
      temp: string | null;
      code: number | null;
      isDay: boolean;
      /** Небо словами из прогноза; null — источник не описал. */
      sky: string | null;
      /** «ветер до 5 м/с»; null — ветра в прогнозе нет. */
      wind: string | null;
      scene: string;
      period: 'day' | 'night';
      skyKind: WeatherSky;
      /** Ближайшие дни после сегодняшнего, до трёх. */
      days: HomeWeatherDay[];
      warning: HomeWeatherWarning | null;
      /** Источник не отвечает: «8 октября в 14:05» — от этого момента прогноз. */
      staleFrom: string | null;
    }
  | { kind: 'failed' }
  | { kind: 'pending' };

export const HOME_WEATHER_ENDPOINT = '/api/weather/home';
