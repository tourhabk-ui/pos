/**
 * lib/routes/track.ts
 *
 * Извлечение GPS-трека маршрута из всех исторических мест хранения.
 * Единая логика для GPX-экспорта и карточки маршрута — раньше жила только
 * в export/route.ts, и карточка не умела показывать трек вовсе.
 *
 * Источники по приоритету:
 * 1. kamchatka_routes.geometry (GeoJSON LineString, [lng, lat, ele?])
 * 2. payload.geometry — legacy JSONB тех же ранних импортов
 * 3. payload.track — legacy массив {lat, lng, elevation?}
 */

export interface TrackPoint {
  lat: number;
  lng: number;
  elevation?: number;
}

interface GeoJsonLineString {
  type?: string;
  coordinates?: number[][];
}

function fromLineString(geom: GeoJsonLineString | null | undefined): TrackPoint[] {
  if (geom?.type !== 'LineString' || !Array.isArray(geom.coordinates)) return [];
  return geom.coordinates
    .filter((c): c is number[] => Array.isArray(c) && c.length >= 2
      && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(c => ({ lng: c[0], lat: c[1], elevation: c[2] as number | undefined }));
}

export function extractTrackpoints(
  geometry: GeoJsonLineString | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): TrackPoint[] {
  const direct = fromLineString(geometry);
  if (direct.length > 0) return direct;

  const p = payload ?? {};
  const legacy = fromLineString(p.geometry as GeoJsonLineString | null);
  if (legacy.length > 0) return legacy;

  const track = p.track;
  if (Array.isArray(track)) {
    return track.filter(
      (pt): pt is TrackPoint =>
        !!pt && typeof pt === 'object'
        && Number.isFinite((pt as TrackPoint).lat)
        && Number.isFinite((pt as TrackPoint).lng),
    );
  }
  return [];
}

/**
 * Прореживание трека для карты карточки: JSON-ответ не должен раздуваться
 * из-за OSM-треков в тысячи точек. Начало и конец сохраняются всегда.
 */
export function decimateTrack(points: TrackPoint[], maxPoints = 600): TrackPoint[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}
