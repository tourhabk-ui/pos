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

const ZONES = {
  mutnovsky:    { lat: 52.4, lon: 158.3, name: 'Мутновский вулкан',   keywords: ['мутновск', 'mutnovsky', 'дачные источники', 'дачных'] },
  nalychevo:    { lat: 53.5, lon: 159.0, name: 'Долина Налычево',     keywords: ['налычево', 'nalychevo'] },
  tolbachik:    { lat: 55.8, lon: 160.3, name: 'Толбачик',            keywords: ['толбачик', 'tolbachik', 'ключевской парк', 'плоский', 'острый толбачик'] },
  klyuchi:      { lat: 56.3, lon: 160.8, name: 'Ключевская группа',   keywords: ['ключевск', 'ключи', 'klyuchi', 'безымянный', 'безымянн', 'шивелуч'] },
  avachinsky:   { lat: 53.3, lon: 158.8, name: 'Авачинский вулкан',   keywords: ['авачинск', 'авача', 'avachinsky', 'корякск', 'козельск'] },
  mutnovsky_s:  { lat: 52.1, lon: 157.8, name: 'Южная Камчатка',      keywords: ['курильское озеро', 'ходутка', 'ксудач', 'кошелев'] },
} satisfies Record<string, { lat: number; lon: number; name: string; keywords: string[] }>;

type ZoneKey = keyof typeof ZONES;

const _cache = new Map<ZoneKey, { text: string; at: number }>();
const TTL_MS = 30 * 60 * 1000;

async function fetchZoneWeather(key: ZoneKey): Promise<string> {
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.text;

  const zone = ZONES[key];
  try {
    const res = await fetch(
      `https://wttr.in/${zone.lat},${zone.lon}?format=j1&lang=ru`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return '';
    const data = await res.json() as WttrResponse;
    const c = data.current_condition?.[0];
    if (!c) return '';
    const desc = c.lang_ru?.[0]?.value ?? c.weatherDesc[0]?.value ?? '';
    const sign = (n: number) => n > 0 ? `+${n}` : String(n);
    const text = `${zone.name}: ${sign(parseInt(c.temp_C))}C (ощущается ${sign(parseInt(c.FeelsLikeC))}C), ${desc}, ветер ${c.windspeedKmph} км/ч`;
    _cache.set(key, { text, at: Date.now() });
    return text;
  } catch { return ''; }
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
