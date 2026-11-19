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
  /**
   * День можно заменить новым черновиком (#3394, срез 2): занятие, отдых или
   * резерв, не часть многодневного тура. Прилёт, отъезд и переезд держат
   * поездку — их не заменяют (то же правило, что у правки плана).
   */
  replaceable: boolean;
  /** Занятие дня (ключ движка); null — день без занятия или не записано. */
  activity: string | null;
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

/** Новый день черновика замены (#3394, срез 2) — то, что видит человек. */
export interface ReplacedDay {
  day: number;
  date: string;
  title: string;
  zone: string;
  /** Строки безопасности и подготовки нового дня. Пусто — у дня их нет. */
  warnings: string[];
}

/** Исход замены дня новым черновиком (lib/trips/trip-replace-day). */
export type ReplaceDayOutcome =
  | { state: 'refused'; reason: string }
  | {
      state: 'drafted';
      draft_id: string;
      /** Что заменено, словами правила плана. */
      note: string;
      day: ReplacedDay;
      /** Предупреждения плана сейчас: закрытия парков, сводка МЧС, «не смогли проверить». */
      plan_warnings: string[];
    }
  | { state: 'failed'; reason: string };

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Ответ двери замены похож на исход. Чужая форма — не исход. */
export function isReplaceDayOutcome(v: unknown): v is ReplaceDayOutcome {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.state === 'refused' || o.state === 'failed') return typeof o.reason === 'string';
  if (o.state !== 'drafted') return false;
  const day = o.day as Record<string, unknown> | null | undefined;
  return typeof o.draft_id === 'string' && /^[0-9a-f-]{36}$/i.test(o.draft_id)
    && typeof o.note === 'string' && isStrings(o.plan_warnings)
    && !!day && typeof day.title === 'string' && isStrings(day.warnings);
}
