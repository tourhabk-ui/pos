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

export type AqiCategory = 'good' | 'moderate' | 'unhealthy_sensitive' | 'unhealthy' | 'very_unhealthy' | 'hazardous';

export interface ZoneAirQuality {
  zone: ZoneKey;
  zoneName: string;
  aqiUs: number;
  mainPollutant: string | null;
  category: AqiCategory;
}

interface IqAirResponse {
  status: string;
  data?: {
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
const lastSuccess = new Map<ZoneKey, { at: number; aqiUs: number }>();

/** Для тестов: сброс стора свежести между кейсами */
export function clearAirQualityFreshness(): void {
  lastSuccess.clear();
}

export async function getZoneAirQuality(zoneKey: ZoneKey): Promise<ZoneAirQuality | null> {
  const apiKey = process.env.IQAIR_API_KEY;
  if (!apiKey) return null;

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

    lastSuccess.set(zoneKey, { at: Date.now(), aqiUs: aqi });

    return {
      zone: zoneKey,
      zoneName: zone.name,
      aqiUs: aqi,
      mainPollutant: data.data?.current?.pollution?.mainus ?? null,
      category: categorizeAqi(aqi),
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
