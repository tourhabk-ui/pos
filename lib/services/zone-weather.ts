/**
 * Zone-aware weather for Kamchatka mountain and volcanic areas.
 * Uses wttr.in with lat/lon coordinates per zone; 30-min cache per zone.
 */

interface WttrCondition {
  temp_C: string;
  FeelsLikeC: string;
  windspeedKmph: string;
  humidity: string;
  weatherDesc: Array<{ value: string }>;
  lang_ru?: Array<{ value: string }>;
}

interface WttrResponse {
  current_condition: WttrCondition[];
}

export const ZONES = {
  mutnovsky:    { lat: 52.4, lon: 158.3, name: 'Мутновский вулкан',   keywords: ['мутновск', 'mutnovsky', 'дачные источники', 'дачных'] },
  nalychevo:    { lat: 53.5, lon: 159.0, name: 'Долина Налычево',     keywords: ['налычево', 'nalychevo'] },
  tolbachik:    { lat: 55.8, lon: 160.3, name: 'Толбачик',            keywords: ['толбачик', 'tolbachik', 'ключевской парк', 'плоский', 'острый толбачик'] },
  klyuchi:      { lat: 56.3, lon: 160.8, name: 'Ключевская группа',   keywords: ['ключевск', 'ключи', 'klyuchi', 'безымянный', 'безымянн', 'шивелуч'] },
  avachinsky:   { lat: 53.3, lon: 158.8, name: 'Авачинский вулкан',   keywords: ['авачинск', 'авача', 'avachinsky', 'корякск', 'козельск'] },
  mutnovsky_s:  { lat: 52.1, lon: 157.8, name: 'Южная Камчатка',      keywords: ['курильское озеро', 'ходутка', 'ксудач', 'кошелев'] },
} satisfies Record<string, { lat: number; lon: number; name: string; keywords: string[] }>;

export type ZoneKey = keyof typeof ZONES;

export interface ZoneWeather {
  key: ZoneKey;
  zoneName: string;
  tempC: number;
  feelsC: number;
  windKmh: number;
  descRu: string;
}

const _cache = new Map<ZoneKey, { data: ZoneWeather | null; at: number }>();
const TTL_MS = 30 * 60 * 1000;

/** Структурная погода зоны (30-мин кэш); null — источник недоступен */
export async function getZoneWeather(key: ZoneKey): Promise<ZoneWeather | null> {
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  const zone = ZONES[key];
  try {
    const res = await fetch(
      `https://wttr.in/${zone.lat},${zone.lon}?format=j1&lang=ru`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as WttrResponse;
    const c = data.current_condition?.[0];
    if (!c) return null;
    const weather: ZoneWeather = {
      key,
      zoneName: zone.name,
      tempC: parseInt(c.temp_C),
      feelsC: parseInt(c.FeelsLikeC),
      windKmh: parseInt(c.windspeedKmph),
      descRu: c.lang_ru?.[0]?.value ?? c.weatherDesc[0]?.value ?? '',
    };
    _cache.set(key, { data: weather, at: Date.now() });
    return weather;
  } catch { return null; }
}

/** Погода всех зон разом (для карточек витрины; один вызов — 6 зон из кэша) */
export async function getAllZonesWeather(): Promise<ZoneWeather[]> {
  const results = await Promise.all(
    (Object.keys(ZONES) as ZoneKey[]).map(k => getZoneWeather(k)),
  );
  return results.filter((w): w is ZoneWeather => w !== null);
}

/**
 * Ближайшая погодная зона к точке; null — точка дальше maxKm от всех зон
 * (крайний север и т.п. — там погоду зоны показывать нечестно).
 */
export function nearestZoneKey(lat: number, lng: number, maxKm = 100): ZoneKey | null {
  let best: ZoneKey | null = null;
  let bestKm = Infinity;
  for (const key of Object.keys(ZONES) as ZoneKey[]) {
    const z = ZONES[key];
    const dLat = (z.lat - lat) * 111;
    const dLng = (z.lon - lng) * 111 * Math.cos((lat * Math.PI) / 180);
    const km = Math.sqrt(dLat * dLat + dLng * dLng);
    if (km < bestKm) { bestKm = km; best = key; }
  }
  return bestKm <= maxKm ? best : null;
}

async function fetchZoneWeather(key: ZoneKey): Promise<string> {
  const w = await getZoneWeather(key);
  if (!w) return '';
  const sign = (n: number) => n > 0 ? `+${n}` : String(n);
  return `${w.zoneName}: ${sign(w.tempC)}C (ощущается ${sign(w.feelsC)}C), ${w.descRu}, ветер ${w.windKmh} км/ч`;
}

/**
 * Detects Kamchatka zones mentioned in query text and returns zone-specific weather.
 * Returns empty string if no zones detected.
 */
export async function getZoneWeatherForText(query: string): Promise<string> {
  if (!query || query.length < 3) return '';
  const lower = query.toLowerCase();

  const matched: ZoneKey[] = [];
  for (const key of Object.keys(ZONES) as ZoneKey[]) {
    if (ZONES[key].keywords.some(kw => lower.includes(kw))) {
      matched.push(key);
      if (matched.length >= 2) break;
    }
  }
  if (!matched.length) return '';

  const results = await Promise.all(matched.map(k => fetchZoneWeather(k)));
  const lines = results.filter(Boolean);
  return lines.length ? `ПОГОДА У МАРШРУТА:\n${lines.join('\n')}` : '';
}
