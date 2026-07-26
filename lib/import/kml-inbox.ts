/**
 * KML-инбокс: приём треков от сообщества (телеграм-каналы карт Камчатки,
 * выгрузки idilesom и т.п.). Файлы кладутся в data/tracks-inbox/ репозитория,
 * workflow постит их на прод-эндпоинт /api/cron/kml-inbox.
 *
 * Правила честности:
 *  - реальные треки (source osm/idilesom/visitkamchatka или немаркированный
 *    настоящий) НЕ перетираются — community-трек пишется только поверх
 *    пустой геометрии, синтетики или прежнего kml_inbox;
 *  - маршрут без совпадения создаётся СКРЫТЫМ (is_visible=false) — очередь
 *    на ревью админа, как у прочих импортов;
 *  - автор трека сохраняется в metadata (атрибуция), в LLM не уходит.
 */

import { pool } from '@/lib/db-pool';

export interface ParsedKml {
  name: string;
  uploader: string | null;
  coordinates: number[][];
}

export interface KmlImportOutcome {
  filename: string;
  track_name: string;
  status: 'imported' | 'created_hidden' | 'kept_existing_track' | 'no_coords' | 'parse_error';
  matched_route?: string;
  matched_route_id?: string;
  match_by?: 'name' | 'proximity';
  points?: number;
  existing_source?: string;
}

/** Разбор KML: имя документа + координаты первого LineString ([lng,lat]). */
export function parseKml(xml: string): ParsedKml | null {
  const nameMatch = xml.match(/<name>([\s\S]*?)<\/name>/);
  const coordsMatch = xml.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
  if (!coordsMatch) return null;

  const coordinates: number[][] = [];
  for (const token of coordsMatch[1].trim().split(/\s+/)) {
    const parts = token.split(',').map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    const [lng, lat, alt] = parts;
    // высоту сохраняем только когда она есть и не нулевая заглушка
    coordinates.push(alt && Number.isFinite(alt) && alt !== 0 ? [lng, lat, alt] : [lng, lat]);
  }

  const { name, uploader } = cleanTrackName(nameMatch?.[1] ?? '');
  return { name, uploader, coordinates };
}

/**
 * «Маршрут Озеро Синичкино. Маршрут загрузил(а) Roman Pozdny» →
 * name «Озеро Синичкино», uploader «Roman Pozdny».
 */
export function cleanTrackName(raw: string): { name: string; uploader: string | null } {
  let s = raw.trim().replace(/\s+/g, ' ');
  let uploader: string | null = null;

  const up = s.match(/маршрут загрузил\(?а\)?[:\s]+(.+?)\.?$/i);
  if (up) {
    uploader = up[1].trim();
    s = s.slice(0, up.index).trim();
  }
  s = s.replace(/^маршрут\s+/i, '').replace(/[.\s]+$/, '').trim();
  return { name: s || raw.trim() || 'Безымянный трек', uploader };
}

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[ёЁ]/g, 'е').replace(/\s+/g, ' ').trim();
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Конец трека в пределах этого радиуса от точки маршрута = совпадение по близости. */
export const MAX_MATCH_DIST_KM = 4;

/** Источники геометрии, поверх которых community-трек писать МОЖНО. */
const OVERWRITABLE_SOURCES = new Set(['waypoints_synthetic', 'kml_inbox']);

export async function importKmlTrack(filename: string, xml: string): Promise<KmlImportOutcome> {
  const parsed = parseKml(xml);
  if (!parsed) return { filename, track_name: filename, status: 'parse_error' };
  if (parsed.coordinates.length < 2) {
    return { filename, track_name: parsed.name, status: 'no_coords', points: parsed.coordinates.length };
  }

  const [startLng, startLat] = parsed.coordinates[0];
  const last = parsed.coordinates[parsed.coordinates.length - 1];

  const { rows } = await pool.query<{
    id: string; title: string; lat: string; lng: string; geom_source: string | null; has_geometry: boolean;
  }>(
    `SELECT id, title, lat::text, lng::text,
            geometry->>'source' AS geom_source,
            (geometry IS NOT NULL) AS has_geometry
     FROM kamchatka_routes
     WHERE lat IS NOT NULL AND lng IS NOT NULL`,
  );

  const wanted = normalizeTitle(parsed.name);
  const candidates = rows.map(r => ({
    ...r,
    latN: parseFloat(r.lat),
    lngN: parseFloat(r.lng),
  }));

  // 1) точное совпадение нормализованного названия; 2) ближайший маршрут,
  // чей центр в MAX_MATCH_DIST_KM от начала ИЛИ конца трека
  let match = candidates.find(r => normalizeTitle(r.title) === wanted) ?? null;
  let matchBy: 'name' | 'proximity' | null = match ? 'name' : null;
  if (!match) {
    let bestDist = MAX_MATCH_DIST_KM;
    for (const r of candidates) {
      const d = Math.min(
        haversineKm(startLat, startLng, r.latN, r.lngN),
        haversineKm(last[1], last[0], r.latN, r.lngN),
      );
      if (d < bestDist) { bestDist = d; match = r; matchBy = 'proximity'; }
    }
  }

  const geojson = JSON.stringify({ type: 'LineString', coordinates: parsed.coordinates, source: 'kml_inbox' });
  const meta = JSON.stringify({
    kml_inbox: { file: filename, uploader: parsed.uploader, original_name: parsed.name },
  });

  if (match) {
    // Реальный трек не перетираем
    if (match.has_geometry && match.geom_source !== null && !OVERWRITABLE_SOURCES.has(match.geom_source)) {
      return {
        filename, track_name: parsed.name, status: 'kept_existing_track',
        matched_route: match.title, matched_route_id: match.id,
        match_by: matchBy ?? undefined, existing_source: match.geom_source,
      };
    }
    if (match.has_geometry && match.geom_source === null) {
      // немаркированный настоящий трек — тоже не трогаем
      return {
        filename, track_name: parsed.name, status: 'kept_existing_track',
        matched_route: match.title, matched_route_id: match.id,
        match_by: matchBy ?? undefined, existing_source: '(без метки)',
      };
    }
    await pool.query(
      `UPDATE kamchatka_routes
       SET geometry = $1::jsonb,
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [geojson, meta, match.id],
    );
    return {
      filename, track_name: parsed.name, status: 'imported',
      matched_route: match.title, matched_route_id: match.id,
      match_by: matchBy ?? undefined, points: parsed.coordinates.length,
    };
  }

  // Нет совпадения — создаём скрытым в очередь на ревью
  await pool.query(
    `INSERT INTO kamchatka_routes (
       category, title, lat, lng, geometry, metadata,
       source_name, is_visible, dedupe_key
     ) VALUES ('trekking', $1, $2, $3, $4::jsonb, $5::jsonb, 'community-kml', false, $6)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET geometry = EXCLUDED.geometry,
           metadata = COALESCE(kamchatka_routes.metadata, '{}'::jsonb) || EXCLUDED.metadata
       WHERE kamchatka_routes.geometry IS NULL
          OR kamchatka_routes.geometry->>'source' IN ('kml_inbox', 'waypoints_synthetic')`,
    [parsed.name, startLat, startLng, geojson, meta, `kml:${wanted}`],
  );
  return {
    filename, track_name: parsed.name, status: 'created_hidden',
    points: parsed.coordinates.length,
  };
}
