/**
 * Чистая логика получения `Remarks` (описание вулкана) из Global Volcanism
 * Program — без сети/БД/AI. Тот же WFS/GeoServer, что и в
 * `lib/geo/gvp-crosscheck.ts`, но с полем `Remarks`, которое кросс-чек
 * намеренно не запрашивал (раздувает ответ, не нужно для сверки координат).
 *
 * Источник — #1830: описания вулканов из `Remarks`, перевод + проверка
 * человеком перед публикацией, НЕ автовставка. Этот файл только достаёт и
 * разбирает английский текст; перевод и запись черновика — в раннере
 * (`gvp-remarks-runner.ts`) и роуте, не здесь.
 */

import type { GeoBounds } from '@/lib/geo/gvp-crosscheck';

const TYPE_NAME = 'GVP-VOTW:E3WebApp_HoloceneVolcanoes';

/** URL WFS GetFeature с полем Remarks — тот же bbox-приём, что у кросс-чека. */
export function buildGvpRemarksUrl(bounds: GeoBounds): string {
  const { latMin, lngMin, latMax, lngMax } = bounds;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'application/json',
    propertyName: 'VolcanoNumber,Remarks',
    bbox: `${lngMin},${latMin},${lngMax},${latMax},EPSG:4326`,
  });
  return `https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs?${params.toString()}`;
}

export interface GvpRemark {
  volcanoNumber: number;
  /** Английский оригинал ГВП. Пустая строка у записей без Remarks — не ошибка, у части вулканов его нет. */
  remarks: string;
}

interface GvpRemarkFeature {
  properties?: {
    VolcanoNumber?: number;
    Remarks?: string | null;
  };
}

/** GeoJSON FeatureCollection → плоский список. Без номера — не кандидат. */
export function parseGvpRemarks(data: unknown): GvpRemark[] {
  const features = (data as { features?: GvpRemarkFeature[] } | null)?.features ?? [];
  const seen = new Set<number>();
  const out: GvpRemark[] = [];

  for (const f of features) {
    const num = f.properties?.VolcanoNumber;
    if (num == null || seen.has(num)) continue;
    seen.add(num);
    out.push({ volcanoNumber: num, remarks: f.properties?.Remarks?.trim() ?? '' });
  }
  return out;
}
