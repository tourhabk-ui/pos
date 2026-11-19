/**
 * lib/trips/trip-now-types.ts — что видит человек в блоке «Сейчас на ваши
 * даты» (#3394). Только типы: их читает и сервер (`trip-now`, `day-fresh`), и
 * клиентский блок (`components/trips/TripNowCheck`). Отдельный файл — чтобы
 * блок не тянул за собой серверные модули правила (сторож
 * `client-regex-no-lookbehind` идёт и по импортам типов).
 */
import type { TripDayAvailability } from './day-availability';

/** Прогноз на дату дня — то, что видит человек. */
export interface TripDayForecast {
  date: string;
  tempMin: number;
  tempMax: number;
  windKmh: number;
  precipMm: number;
  description: string;
  /** Плохая погода: ветер от 40 км/ч или осадки от 10 мм. */
  bad: boolean;
}

/** Что изменилось у одного дня. */
export interface TripNowDay {
  day: number;
  date: string;
  /** Строки безопасности, которых в сохранённом дне не было. */
  added: string[];
  /** Сохранённые строки безопасности, которые больше не действуют. */
  gone: string[];
  /** Места тура дня на его дату; null — у дня нет тура. */
  availability: TripDayAvailability | null;
  /** Прогноз на дату; есть только при `weather_state: 'ok'`. */
  weather: TripDayForecast | null;
  /**
   * Почему прогноз есть или его нет: `ok`; `later` — дата дальше горизонта
   * прогноза (16 суток), спрашивать рано; `unavailable` — в горизонте, но
   * прогноз не получен или день в нём неполный; `not_checked` — день без
   * занятия или без координат.
   */
  weather_state: 'ok' | 'later' | 'unavailable' | 'not_checked';
}

export type TripNow =
  | { state: 'no_dates' }
  | { state: 'past'; last_day: string }
  | {
      state: 'checked';
      checked_at: string;
      days: TripNowDay[];
      /** Предупреждения плана сейчас: закрытия парков, сводка МЧС, «не смогли проверить». */
      plan_warnings: string[];
      /** Строки безопасности хоть у одного дня изменились. */
      safety_changed: boolean;
    };
