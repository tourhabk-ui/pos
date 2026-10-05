/**
 * Погода зон Камчатки — горных и вулканических районов, по точке зоны.
 *
 * ── 04.10: wttr.in → Open-Meteo ───────────────────────────────────────────
 *
 * Проверка по просьбе владельца («погода по районам, проверь корректность»,
 * проба 708): пять зон из шести — Мутновский, Налычево, Толбачик,
 * Авачинский, Юг — отдавали ОДНО И ТО ЖЕ: +8°, ветер 26 км/ч, «Солнечно».
 * wttr.in прижимает точку к одной станции, и «погода по районам» была погодой
 * одного места. Ключи — по-английски («Patchy rain nearby»). Open-Meteo в тех
 * же точках: Авачинский (943 м) +0.8° с порывами до 70 км/ч, юг — порывы
 * 65 км/ч, Толбачик −5.8°; официальное предупреждение того же часа —
 * «ветер в прибрежных районах 15–20 м/с». Кузьмич и Telegram отвечали
 * туристу «солнечно, 26 км/ч».
 *
 * Open-Meteo уже живёт в платформе (lib/planner/intelligence, ensemble):
 * новой сетевой зависимости нет. Порывы — отдельным полем: на вулкане решает
 * порыв, а не средний ветер. Высота точки — тоже: +1° на 943 м и в городе —
 * разные новости. 30-минутный кэш на зону; отказ называется в логе и даёт
 * null — «погоды нет», а не выдуманную.
 */

import { wmoDescriptionRu } from '@/lib/weather/wmo-hazard';

interface OpenMeteoCurrent {
  temperature_2m?: unknown;
  apparent_temperature?: unknown;
  wind_speed_10m?: unknown;
  wind_gusts_10m?: unknown;
  weather_code?: unknown;
}

interface OpenMeteoResponse {
  elevation?: unknown;
  current?: OpenMeteoCurrent;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
  /** Порывы, км/ч; null — модель не отдала. */
  gustKmh: number | null;
  /** Высота точки модели, м; null — не отдана. */
  elevationM: number | null;
  /** Описание по коду WMO; пусто — код незнаком, подписи нет. */
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${zone.lat}&longitude=${zone.lon}`
      + '&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code'
      + '&wind_speed_unit=kmh&timezone=Asia%2FKamchatka';
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      console.error('[zone-weather] Open-Meteo ответил', res.status, key);
      return null;
    }
    const data = await res.json() as OpenMeteoResponse;
    const c = data.current;
    const temp = num(c?.temperature_2m);
    const wind = num(c?.wind_speed_10m);
    if (temp == null || wind == null) {
      console.error('[zone-weather] в ответе нет температуры или ветра', key);
      return null;
    }
    const code = num(c?.weather_code);
    const gust = num(c?.wind_gusts_10m);
    const elev = num(data.elevation);
    const weather: ZoneWeather = {
      key,
      zoneName: zone.name,
      tempC: Math.round(temp),
      feelsC: Math.round(num(c?.apparent_temperature) ?? temp),
      windKmh: Math.round(wind),
      gustKmh: gust == null ? null : Math.round(gust),
      elevationM: elev == null ? null : Math.round(elev),
      descRu: wmoDescriptionRu(code) ?? '',
    };
    _cache.set(key, { data: weather, at: Date.now() });
    return weather;
  } catch (err) {
    console.error('[zone-weather] Open-Meteo не ответил', key, err instanceof Error ? err.message : err);
    return null;
  }
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
  const where = w.elevationM != null ? `${w.zoneName} (~${w.elevationM} м)` : w.zoneName;
  const parts = [`${sign(w.tempC)}C (ощущается ${sign(w.feelsC)}C)`];
  if (w.descRu) parts.push(w.descRu);
  parts.push(`ветер ${w.windKmh} км/ч`);
  if (w.gustKmh != null && w.gustKmh > w.windKmh) parts.push(`порывы до ${w.gustKmh} км/ч`);
  return `${where}: ${parts.join(', ')}`;
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
