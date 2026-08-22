/**
 * lib/services/air-quality.ts
 *
 * Качество воздуха по вулканическим зонам Камчатки через IQAir (api.airvisual.com) —
 * дополнительный сигнал к МЧС/КБГС-алертам (lib/services/seismic-parser.ts):
 * пепловый выброс вулкана поднимает PM2.5/AQI в ближайших станциях мониторинга.
 *
 * IQAir не гарантирует станцию мониторинга рядом с удалённым вулканом —
 * "nearest_city" может вернуть станцию за сотни км (реалистично только для
 * Петропавловска-Камчатского/avachinsky). Отсутствие данных — не "плохо",
 * это отдельный флаг, а не 0/null AQI молча.
 *
 * Env: IQAIR_API_KEY (без ключа — функция возвращает null, без ошибки).
 */

import { ZONES, type ZoneKey } from './zone-weather';
import { haversineKm } from '@/lib/field/geo';

export type AqiCategory = 'good' | 'moderate' | 'unhealthy_sensitive' | 'unhealthy' | 'very_unhealthy' | 'hazardous';

export interface ZoneAirQuality {
  zone: ZoneKey;
  zoneName: string;
  aqiUs: number;
  mainPollutant: string | null;
  category: AqiCategory;
  /**
   * Станция, которая эту цифру дала, и как далеко она от зоны.
   *
   * До 23.08.2026 модуль брал из ответа IQAir только `aqius` и `mainus`, а
   * `city`/`state`/координаты выбрасывал. Получалось «Толбачик: AQI 42» без
   * возможности узнать, что мерили в Петропавловске за сотни километров.
   * Замер того же дня: из шести зон отвечают две, обе рядом с городом, —
   * значит вопрос «откуда цифра» не теоретический, он решает, можно ли её
   * вообще показывать.
   *
   * `null` — IQAir станцию не назвал. Это «не знаю», и оно не равно «рядом».
   */
  station: AirStation | null;
}

export interface AirStation {
  /** Как назвал себя источник: город и регион станции. */
  name: string;
  /** Расстояние от центра зоны до станции; null — координат станции нет. */
  distanceKm: number | null;
  /** Годится ли цифра как воздух ЭТОЙ зоны — см. STATION_NEAR_KM. */
  represents: StationProximity;
}

/**
 * Что цифра описывает: саму зону, окрестность или далёкое место.
 *
 * `unknown` — расстояние неизвестно, и выдавать его за близкое нельзя (§4.0).
 */
export type StationProximity = 'zone' | 'nearby' | 'distant' | 'unknown';

/**
 * Порог «это воздух зоны», км. Тридцать — потому что пепловый шлейф на таком
 * расстоянии ещё один и тот же, а городская станция за полсотни километров
 * меряет уже другой воздух: транспорт и котельные, а не вулкан.
 */
export const STATION_NEAR_KM = 30;
/** Дальше этого станция к зоне отношения не имеет — только к региону. */
export const STATION_REGION_KM = 120;

/** Чистая: как далеко станция и что это значит. Без сети и без БД. */
export function stationProximity(distanceKm: number | null): StationProximity {
  if (distanceKm === null) return 'unknown';
  if (distanceKm <= STATION_NEAR_KM) return 'zone';
  if (distanceKm <= STATION_REGION_KM) return 'nearby';
  return 'distant';
}

interface IqAirResponse {
  status: string;
  data?: {
    /** Город станции — IQAir его возвращает, мы его раньше выбрасывали. */
    city?: string;
    state?: string;
    /** GeoJSON: [долгота, широта] — порядок именно такой. */
    location?: { coordinates?: [number, number] };
    current?: {
      pollution?: {
        aqius?: number;
        mainus?: string;
      };
    };
  };
}

export function categorizeAqi(aqi: number): AqiCategory {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'unhealthy_sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very_unhealthy';
  return 'hazardous';
}

// Последние успешные измерения по зонам — для метрики покрытия (issue #291):
// «свежесть» сигнала = был ли успешный ответ IQAir за последние 6 часов.
// In-memory достаточно: метрика про живость внешнего сигнала, не про историю.
const lastSuccess = new Map<ZoneKey, { at: number; aqiUs: number; station: AirStation | null }>();

/** Для тестов: сброс стора свежести между кейсами */
export function clearAirQualityFreshness(): void {
  lastSuccess.clear();
}

/**
 * Кто ответил и откуда. Ничего не выдумывает: нет имени — нет станции, нет
 * координат — расстояние `null`, а не ноль.
 */
function readStation(res: IqAirResponse, zoneLat: number, zoneLon: number): AirStation | null {
  const city = res.data?.city?.trim();
  const state = res.data?.state?.trim();
  if (!city && !state) return null;

  const coords = res.data?.location?.coordinates;
  // GeoJSON — [lon, lat]. Перепутать местами здесь значит получить станцию в
  // океане и «расстояние» в тысячи километров, выглядящее как настоящее.
  const distanceKm = Array.isArray(coords) && coords.length === 2
    && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
    ? Math.round(haversineKm(zoneLat, zoneLon, coords[1], coords[0]))
    : null;

  return {
    name: [city, state].filter(Boolean).join(', '),
    distanceKm,
    represents: stationProximity(distanceKm),
  };
}

export async function getZoneAirQuality(zoneKey: ZoneKey): Promise<ZoneAirQuality | null> {
  // Обрезка обязательна: значение из пробелов проходит проверку на
  // truthiness и уезжает в URL как ключ. Провайдер отвечает отказом, а
  // платформа считает, что ключ задан, — 09.08 это уже стоило дня разбора.
  const apiKey = (process.env.IQAIR_API_KEY ?? '').trim();
  if (apiKey === '') return null;

  const zone = ZONES[zoneKey];
  try {
    const res = await fetch(
      `https://api.airvisual.com/v2/nearest_city?lat=${zone.lat}&lon=${zone.lon}&key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;

    const data = await res.json() as IqAirResponse;
    const aqi = data?.data?.current?.pollution?.aqius;
    if (typeof aqi !== 'number') return null;

    const station = readStation(data, zone.lat, zone.lon);
    lastSuccess.set(zoneKey, { at: Date.now(), aqiUs: aqi, station });

    return {
      zone: zoneKey,
      zoneName: zone.name,
      aqiUs: aqi,
      mainPollutant: data.data?.current?.pollution?.mainus ?? null,
      category: categorizeAqi(aqi),
      station,
    };
  } catch {
    return null;
  }
}

export async function getAllZonesAirQuality(): Promise<ZoneAirQuality[]> {
  const keys = Object.keys(ZONES) as ZoneKey[];
  const results = await Promise.all(keys.map(getZoneAirQuality));
  return results.filter((r): r is ZoneAirQuality => r !== null);
}

// ── Метрика покрытия (issue #291) ─────────────────────────────────────────────

/** Свежим считаем сигнал не старше 6 часов — пепловая обстановка меняется быстрее суток */
const FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ZoneCoverage {
  zone: ZoneKey;
  zoneName: string;
  fresh: boolean;
  /** Возраст последнего успешного измерения в минутах; null — данных не было вовсе */
  ageMinutes: number | null;
  /**
   * Кто ответил за эту зону и как далеко он от неё.
   *
   * Покрытие без этого поля отвечает «данные есть», умалчивая, что мерили за
   * сотни километров. Замер 23.08: отвечают две зоны из шести, обе рядом с
   * Петропавловском, — то есть вопрос «откуда цифра» решает, годится ли
   * сигнал вообще.
   */
  station: AirStation | null;
}

export interface CoverageStats {
  total_zones: number;
  zones_with_fresh_data: number;
  stale_zones: ZoneCoverage[];
  coverage_pct: number;
  zones: ZoneCoverage[];
}

/**
 * Пробует все вулканические зоны и считает долю с живым (<6ч) сигналом IQAir.
 * Проба обновляет lastSuccess внутри getZoneAirQuality, поэтому зона, ответившая
 * сейчас, всегда fresh; упавшая — fresh только если недавно отвечала.
 */
export async function getCoverageStats(): Promise<CoverageStats> {
  const keys = Object.keys(ZONES) as ZoneKey[];
  await Promise.all(keys.map(getZoneAirQuality));

  const now = Date.now();
  const zones: ZoneCoverage[] = keys.map(key => {
    const last = lastSuccess.get(key);
    const ageMs = last ? now - last.at : null;
    return {
      zone: key,
      zoneName: ZONES[key].name,
      fresh: ageMs !== null && ageMs < FRESHNESS_WINDOW_MS,
      ageMinutes: ageMs !== null ? Math.round(ageMs / 60_000) : null,
      station: last?.station ?? null,
    };
  });

  const freshCount = zones.filter(z => z.fresh).length;
  return {
    total_zones: keys.length,
    zones_with_fresh_data: freshCount,
    stale_zones: zones.filter(z => !z.fresh),
    coverage_pct: keys.length > 0 ? Math.round((freshCount / keys.length) * 100) : 0,
    zones,
  };
}
