/**
 * Чистая логика сверки вулканов `places` с Global Volcanism Program
 * (Смитсоновский институт) — без сети/БД.
 *
 * Источник независим от OSM: научная база, а не краудсорс, и покрывает
 * ровно вулканы — 1214 голоценовых в мире (замер 11.09, `resultType=hits`
 * на слое `E3WebApp_HoloceneVolcanoes`). Проверено пробой с раннера GitHub
 * (сеть из контейнера разработки закрыта политикой egress): публичный
 * WFS/GeoServer, ключ не нужен, `propertyName` и `bbox` режут ответ на
 * сервере (подтверждено — bbox по конверту Камчатки вернул именно
 * камчатские вулканы: Ключевской, Шивелуч, Толбачик и другие).
 *
 * ── Почему без сравнения имён (в отличие от osm-crosscheck.ts) ────────────
 *
 * `places.name` — по-русски («Ключевской»), `VolcanoName` в GVP — английская
 * транслитерация («Klyuchevskoy»). `pg_trgm.similarity()` между разными
 * алфавитами возвращает практически ноль: сравнение имён здесь бесполезно,
 * а не просто менее точно. Своя транслитерация не пишется — готовых схем
 * несколько («Kliuchevskoi» тоже верно), и подгонка под конкретный ответ
 * ГВП была бы подгонкой факта под удобство, а не проверкой (§4.0).
 *
 * Вместо этого — ближайший сосед по расстоянию, без фильтра по имени: и
 * наших вулканов, и вулканов ГВП в границах Камчатки мало (десятки, не
 * тысячи), частых кластеров с шагом в сотни метров нет. Кандидатов —
 * несколько (не один), чтобы человек мог отличить настоящее совпадение от
 * соседнего вулкана: английское имя известного вулкана узнаваемо на слух
 * («Sheveluch» — Шивелуч) без алгоритма транслитерации.
 */

import { distanceKm } from '@/lib/routes/place-link';
import { isExtendedObject } from '@/lib/places/coord-source';

export interface GeoBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

const TYPE_NAME = 'GVP-VOTW:E3WebApp_HoloceneVolcanoes';
const PROPERTIES = [
  'VolcanoNumber', 'VolcanoName', 'Country', 'VolcanoType',
  'LastEruption', 'Elevation', 'LatitudeDecimal', 'LongitudeDecimal',
];

/**
 * URL WFS GetFeature. `propertyName` обрезает поля на сервере (без него
 * `Remarks`/`VPImage*` раздувают ответ текстом на каждый вулкан мира —
 * замер 11.09), `bbox` фильтрует по региону тоже на сервере, а не в JS.
 * Порядок bbox — `lngMin,latMin,lngMax,latMax` — подтверждён пробой, не
 * взят из спецификации: формальный EPSG:4416.4326 предписывает lat,lng, но
 * этот GeoServer принимает lng,lat и возвращает верные камчатские вулканы
 * именно в таком порядке.
 */
export function buildGvpFeatureUrl(bounds: GeoBounds): string {
  const { latMin, lngMin, latMax, lngMax } = bounds;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'application/json',
    propertyName: PROPERTIES.join(','),
    bbox: `${lngMin},${latMin},${lngMax},${latMax},EPSG:4326`,
  });
  return `https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs?${params.toString()}`;
}

export interface GvpVolcano {
  volcanoNumber: number;
  name: string;
  country: string | null;
  volcanoType: string | null;
  /** Год последнего извержения; отрицательный — до н.э. `null` — не записано. */
  lastEruption: number | null;
  elevationM: number | null;
  lat: number;
  lng: number;
}

interface GvpFeature {
  properties?: {
    VolcanoNumber?: number;
    VolcanoName?: string;
    Country?: string | null;
    VolcanoType?: string | null;
    LastEruption?: number | null;
    Elevation?: number | null;
    LatitudeDecimal?: number;
    LongitudeDecimal?: number;
  };
}

/**
 * GeoJSON FeatureCollection → плоский список. Без номера/имени/координат —
 * не кандидат: сравнивать не с чем. Дедуп по `VolcanoNumber` — уникальный
 * идентификатор ГВП, устойчивее имени.
 */
export function parseGvpFeatures(data: unknown): GvpVolcano[] {
  const features = (data as { features?: GvpFeature[] } | null)?.features ?? [];
  const seen = new Set<number>();
  const out: GvpVolcano[] = [];

  for (const f of features) {
    const p = f.properties;
    const name = p?.VolcanoName?.trim();
    const num = p?.VolcanoNumber;
    const lat = p?.LatitudeDecimal;
    const lng = p?.LongitudeDecimal;
    if (num == null || !name || lat == null || lng == null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (seen.has(num)) continue;
    seen.add(num);

    out.push({
      volcanoNumber: num,
      name,
      country: p?.Country ?? null,
      volcanoType: p?.VolcanoType ?? null,
      lastEruption: p?.LastEruption ?? null,
      elevationM: p?.Elevation ?? null,
      lat,
      lng,
    });
  }
  return out;
}

export interface PlaceInput {
  id: string;
  name: string;
  locationType: string | null;
  lat: number | null;
  lng: number | null;
}

export interface VolcanoCandidate {
  volcanoNumber: number;
  name: string;
  country: string | null;
  volcanoType: string | null;
  lastEruption: number | null;
  elevationM: number | null;
  lat: number;
  lng: number;
  distanceKm: number;
}

export interface VolcanoCrosscheckItem {
  placeId: string;
  name: string;
  locationType: string | null;
  isExtendedObject: boolean;
  ourLat: number;
  ourLng: number;
  /** Расстояние до БЛИЖАЙШЕГО вулкана ГВП — улика, не приговор. */
  nearestKm: number;
  candidates: VolcanoCandidate[];
}

export interface VolcanoCrosscheckResult {
  items: VolcanoCrosscheckItem[];
  /** Место без координат или ГВП не отдал ни одного вулкана — «не смог», не «ошибка = 0». */
  itemsWithoutCandidatesTotal: number;
}

/**
 * Сборка по всем местам-вулканам сразу.
 *
 * Кандидаты — ближайшие K по расстоянию, БЕЗ фильтра по имени (см. шапку
 * файла). Сортировка мест — по убыванию расстояния до ближайшего кандидата:
 * чем дальше независимо известный вулкан, тем громче улика. Порога нет —
 * решение за человеком, читающим список (тот же принцип, что в
 * `osm-crosscheck.ts` и `lib/routes/place-link.ts`: жёсткое правило без
 * разбора глазами уже портило верные записи).
 */
export function buildVolcanoCrosscheckItems(
  places: PlaceInput[],
  volcanoes: GvpVolcano[],
  opts: { limit?: number } = {},
): VolcanoCrosscheckResult {
  const limit = opts.limit ?? 3;
  const items: VolcanoCrosscheckItem[] = [];
  let withoutCandidates = 0;

  for (const place of places) {
    if (place.lat == null || place.lng == null || volcanoes.length === 0) {
      withoutCandidates += 1;
      continue;
    }
    const lat = place.lat;
    const lng = place.lng;

    const candidates: VolcanoCandidate[] = volcanoes
      .map(v => ({
        volcanoNumber: v.volcanoNumber,
        name: v.name,
        country: v.country,
        volcanoType: v.volcanoType,
        lastEruption: v.lastEruption,
        elevationM: v.elevationM,
        lat: v.lat,
        lng: v.lng,
        distanceKm: Math.round(distanceKm(lat, lng, v.lat, v.lng) * 10) / 10,
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);

    items.push({
      placeId: place.id,
      name: place.name,
      locationType: place.locationType,
      isExtendedObject: isExtendedObject(place.locationType),
      ourLat: lat,
      ourLng: lng,
      nearestKm: candidates[0].distanceKm,
      candidates,
    });
  }

  items.sort((a, b) => b.nearestKm - a.nearestKm);

  return { items, itemsWithoutCandidatesTotal: withoutCandidates };
}
