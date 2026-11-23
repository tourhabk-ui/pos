/**
 * Зона и точка дня — по записанной зоне места и по его координатам
 * (PDF владельца 23.11: Толбачик подписан «Авачинская зона» и получал
 * погоду Авачи).
 *
 * Записанная зона планера остаётся. Широта южнее порога — южная, как
 * `plannerZoneOf`. Единственная поправка: точка далеко от центра Авачинской
 * зоны, а в записи стоит «avachinsky» или зоны нет вовсе, и по правилу
 * эпицентра (`zonesForEpicenter`, широта ≥ 55.5 — север) это север или
 * восток. Так миграция 1294 уже поправила Толбачик: он северный, хотя
 * восточный центр зоны к нему ближе — ближайший центр здесь врёт, и им
 * зона не выбирается.
 *
 * Записанные western / eastern / northern / southern не переписываются.
 * Координат нет — зоны по точке нет: «не знаю» не становится Авачей.
 */
import { distanceKm } from '@/lib/geo/kamchatka';
import { SOUTHERN_ZONE_MAX_LAT, type ZoneId } from '@/lib/planner/constants';
import { asPlannerZone, plannerZoneOf } from '@/lib/planner/zone-style';
import { zonesForEpicenter } from '@/lib/services/safety/seismic-zones';

/** Центр Авачинской зоны — то же, что `ZONE_COORDS.avachinsky` в движке. */
export const AVACHA_ZONE_CENTER: [number, number] = [53.25, 158.75];

/**
 * Дальше этого — точка не «город с ошибочной подписью рядом».
 * Толбачик ~280 км; вулканы у города ближе.
 */
export const AVACHA_MISLABEL_KM = 150;

export interface PlacePointInput {
  recordedZone: string | null | undefined;
  lat: number | null;
  lng: number | null;
}

export interface PlacePoint {
  /** null — зону по записи и по точке назвать нельзя, точка для погоды есть. */
  zone: ZoneId | null;
  point: [number, number] | null;
  fromCoords: boolean;
}

function pointZone(lat: number, lng: number): ZoneId | null {
  if (lat < SOUTHERN_ZONE_MAX_LAT) return 'southern';
  const zones = zonesForEpicenter(lat, lng);
  return zones.length === 1 ? asPlannerZone(zones[0]) : null;
}

export function placePoint(input: PlacePointInput): PlacePoint | null {
  const known = typeof input.lat === 'number' && typeof input.lng === 'number'
    && Number.isFinite(input.lat) && Number.isFinite(input.lng);
  const lat = known ? input.lat as number : null;
  const lng = known ? input.lng as number : null;
  let zone = plannerZoneOf(input.recordedZone, lat);
  if (known && lat !== null && lng !== null && zone !== 'southern') {
    const fromPoint = pointZone(lat, lng);
    const far = distanceKm({ lat, lng }, { lat: AVACHA_ZONE_CENTER[0], lng: AVACHA_ZONE_CENTER[1] }) > AVACHA_MISLABEL_KM;
    if (fromPoint && fromPoint !== 'avachinsky' && far && (zone === 'avachinsky' || zone === null)) {
      zone = fromPoint;
    }
  }
  if (!zone && !known) return null;
  return { zone, point: known && lat !== null && lng !== null ? [lat, lng] : null, fromCoords: known };
}
