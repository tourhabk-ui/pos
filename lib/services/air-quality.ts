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
