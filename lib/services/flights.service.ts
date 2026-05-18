/**
 * Flights Service — подбор рейсов на Камчатку (PKC)
 * Deeplinks с маркером Aviasales + актуальные цены сезона 2026
 */

export interface Flight {
  id: string;
  airline: string;
  departure_city: string;
  departure_code: string;
  arrival_city: 'Петропавловск-Камчатский';
  arrival_code: 'PKC';
  price_from_rub: number;
  duration_hours: number;
  stops: number;
  link: string;
}

export interface FlightRecommendation {
  primary_route: Flight;
  alternative_routes: Flight[];
  avg_price: number;
  discount_available: boolean;
  seasonal_notes: string;
}

const AVIASALES_MARKER = '402896';

const ROUTES: Record<string, {
  city: string;
  price_low: number;
  price_avg: number;
  duration_hours: number;
  stops: number;
  airline: string;
}> = {
  MOW: { city: 'Москва',               price_low: 16000, price_avg: 24000, duration_hours: 8.5, stops: 1, airline: 'Аэрофлот / S7' },
  LED: { city: 'Санкт-Петербург',       price_low: 18000, price_avg: 26000, duration_hours: 9.5, stops: 1, airline: 'S7 / Победа+' },
  VVO: { city: 'Владивосток',           price_low:  7500, price_avg: 12000, duration_hours: 3.0, stops: 0, airline: 'Аврора' },
  OVB: { city: 'Новосибирск',           price_low: 11000, price_avg: 18000, duration_hours: 5.5, stops: 1, airline: 'S7 / Аэрофлот' },
  SVX: { city: 'Екатеринбург',          price_low: 14000, price_avg: 21000, duration_hours: 7.0, stops: 1, airline: 'Уральские авиалинии' },
  KHV: { city: 'Хабаровск',             price_low:  6000, price_avg: 10000, duration_hours: 2.5, stops: 0, airline: 'Аврора' },
  IKT: { city: 'Иркутск',               price_low:  9000, price_avg: 14000, duration_hours: 4.5, stops: 1, airline: 'S7' },
  UFA: { city: 'Уфа',                   price_low: 15000, price_avg: 22000, duration_hours: 8.0, stops: 1, airline: 'Аэрофлот' },
};

const CITY_ALIASES: Record<string, string> = {
  'москва': 'MOW', 'питер': 'LED', 'санкт-петербург': 'LED', 'спб': 'LED',
  'новосибирск': 'OVB', 'екатеринбург': 'SVX', 'хабаровск': 'KHV',
  'владивосток': 'VVO', 'иркутск': 'IKT', 'уфа': 'UFA',
};

function buildLink(from: string, departureDate?: string): string {
  const date = departureDate ?? getNextPeakDate();
  return `https://www.aviasales.ru/search/${from}${date.replace(/-/g, '')}PKC1?marker=${AVIASALES_MARKER}`;
}

function getNextPeakDate(): string {
  const now = new Date();
  const peak = new Date(now.getFullYear(), 6, 15); // 15 июля
  if (now > peak) peak.setFullYear(peak.getFullYear() + 1);
  return peak.toISOString().slice(0, 10).replace(/-/g, '');
}

function isSummerSeason(): boolean {
  const m = new Date().getMonth();
  return m >= 5 && m <= 8;
}

function resolveCode(input: string): string | null {
  const up = input.toUpperCase().trim();
  if (ROUTES[up]) return up;
  return CITY_ALIASES[input.toLowerCase().trim()] ?? null;
}

export function recommendFlights(cityOrCode?: string): FlightRecommendation {
  const code = cityOrCode ? (resolveCode(cityOrCode) ?? 'MOW') : 'MOW';
  const route = ROUTES[code] ?? ROUTES['MOW'];

  const primary: Flight = {
    id: `${code}-PKC`,
    airline: route.airline,
    departure_city: route.city,
    departure_code: code,
    arrival_city: 'Петропавловск-Камчатский',
    arrival_code: 'PKC',
    price_from_rub: route.price_low,
    duration_hours: route.duration_hours,
    stops: route.stops,
    link: buildLink(code),
  };

  const SHOW_ALTS = ['MOW', 'VVO', 'KHV', 'OVB'];
  const alternatives: Flight[] = Object.entries(ROUTES)
    .filter(([c]) => c !== code && SHOW_ALTS.includes(c))
    .slice(0, 3)
    .map(([c, r]) => ({
      id: `${c}-PKC-alt`,
      airline: r.airline,
      departure_city: r.city,
      departure_code: c,
      arrival_city: 'Петропавловск-Камчатский',
      arrival_code: 'PKC',
      price_from_rub: r.price_low,
      duration_hours: r.duration_hours,
      stops: r.stops,
      link: buildLink(c),
    }));

  const all = [primary.price_from_rub, ...alternatives.map(f => f.price_from_rub)];
  const avg_price = Math.round(all.reduce((a, b) => a + b) / all.length);

  return {
    primary_route: primary,
    alternative_routes: alternatives,
    avg_price,
    discount_available: !isSummerSeason(),
    seasonal_notes: isSummerSeason()
      ? 'Пиковый сезон (июнь–сентябрь) — цены на 30–50% выше. Бронируйте за 2–3 месяца.'
      : 'Низкий сезон — скидки до 40%. Лучшее время для снегоходных туров.',
  };
}

export function getFlightLink(from: string, departureDate?: string): string {
  const code = resolveCode(from) ?? 'MOW';
  return buildLink(code, departureDate);
}
