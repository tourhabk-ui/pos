/**
 * Вход «Подробной программы» (/api/planner/itinerary) приходит из браузера —
 * ему нельзя верить как источнику того, что уходит в зарубежную модель.
 * Пять заходов ревью безопасности #3743 показали: чистить свободный текст
 * словарём бесполезно — словарь здоровья всегда неполон. Поэтому свободного
 * текста от браузера в промпте нет вовсе:
 *  — заголовок дня с туром и имя оператора — из НАШЕЙ БД по id тура
 *    (только туры с витрины, publicTourSql); тур не найден — день без тура;
 *  — день без тура — фиксированная фраза по типу дня и виду активности
 *    из закрытых списков;
 *  — предупреждения — фиксированные фразы по типу из закрытого списка;
 *    текст предупреждения от браузера не читается; типы fitness, safety,
 *    seasickness (выводятся из самочувствия) не идут совсем;
 *  — прогноз — только температуры; цена — число и единица тура из БД.
 */
import { ACTIVITY_LABEL } from '@/lib/planner-constants';

export const DAY_TYPES = ['arrival', 'activity', 'travel', 'rest', 'buffer', 'departure'] as const;
export type ItineraryDayType = typeof DAY_TYPES[number];

const DAY_PHRASE: Record<ItineraryDayType, string> = {
  arrival: 'Прилёт и размещение',
  activity: 'Самостоятельный день',
  travel: 'Переезд',
  rest: 'День отдыха',
  buffer: 'Резервный день на случай непогоды',
  departure: 'Вылет',
};

export const WARNING_PHRASE: Record<string, string> = {
  permit: 'для части мест нужно разрешение',
  season: 'часть активностей зависит от сезона',
  children: 'в группе дети — программа адаптирована',
  duration: 'срок поездки ограничивает программу',
  weather: 'погода может менять планы',
  license: 'часть услуг — только у лицензированного оператора',
  crowd: 'в популярных местах бывает людно',
  mchs: 'по маршруту есть сводки МЧС',
  zone_days: 'дальняя зона уместилась не целиком',
  home_nights: 'ночи в Авачинской зоне — дома у туриста',
  tour_dates: 'часть туров не встала по датам',
  dates: 'даты поездки уточняются',
};

export interface ItineraryDayIn {
  day: number; type: ItineraryDayType; zone: string;
  activityType?: string; tourId?: string; realPrice?: number; priceMissing?: boolean;
  temp?: { min: number; max: number };
}
export interface PublicTour { id: string; title: string; operatorName: string; priceUnit: string | null }

/** Дни для промпта: весь текст — из БД или закрытых списков. */
export function itineraryDays(days: ItineraryDayIn[], tours: ReadonlyMap<string, PublicTour>) {
  return days.map((d) => {
    const tour = d.type === 'activity' && d.tourId ? tours.get(d.tourId) : undefined;
    const label = d.activityType ? ACTIVITY_LABEL[d.activityType] : undefined;
    const title = tour
      ? tour.title
      : d.type === 'activity' && label ? `${DAY_PHRASE.activity}: ${label.toLowerCase()}` : DAY_PHRASE[d.type];
    return {
      day: d.day, type: d.type, title, zone: d.zone,
      ...(tour ? { realTour: { operatorName: tour.operatorName, ...(tour.priceUnit ? { priceUnit: tour.priceUnit } : {}) } } : {}),
      ...(tour && d.realPrice ? { realPrice: d.realPrice } : {}),
      ...(d.priceMissing ? { priceMissing: 'цену называет оператор' } : {}),
      ...(d.temp ? { weatherForecast: { description: 'прогноз', tempMin: d.temp.min, tempMax: d.temp.max } } : {}),
    };
  });
}

/** Предупреждения для промпта: фраза по типу, без текста браузера, без повторов. */
export function itineraryWarnings(warnings: Array<{ type: string; severity: 'critical' | 'important' | 'info' }>) {
  const seen = new Set<string>();
  const out: Array<{ type: string; severity: 'critical' | 'important' | 'info'; message: string }> = [];
  for (const w of warnings) {
    const message = WARNING_PHRASE[w.type];
    if (!message || seen.has(w.type)) continue;
    seen.add(w.type);
    out.push({ type: w.type, severity: w.severity, message });
  }
  return out;
}
