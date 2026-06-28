/**
 * lib/services/visitkamchatka-gpx-importer.ts
 *
 * Скачивает официальные GPX-треки visitkamchatka.ru,
 * матчит на kamchatka_routes по стартовой точке, пишет geometry.
 */

import { pool } from '@/lib/db-pool';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

const GPX_ROUTES: Record<string, string> = {
  'bukhta-pionerskaya':        'https://visitkamchatka.ru/upload/iblock/e31/635nw7m8jd86wu5px6d064q145zoff39/Bukhta_Pionerskaya.gpx',
  'dachnye-istochniki':        'https://visitkamchatka.ru/upload/iblock/8d2/d89br1g0wqma1ee40p6nmhd7rurg23ax/Dachnye_istochniki.gpx',
  'ganalskie-vostryaki':       'https://visitkamchatka.ru/upload/iblock/eb6/66tti8m1k2cqssksjaep3rxor4386t87/trek_Ganaly.gpx',
  'golubye-ozera':             'https://visitkamchatka.ru/upload/iblock/3d8/xr21s2jiigzw3xvl419ps7ijjivykdfm/track_20240620_141055_trek_do_golubykh_oze_r_po_ruchyu.gpx',
  'gornyy-massiv-vachkazhets': 'https://visitkamchatka.ru/upload/iblock/bd0/yts6azv2zfz9x78exsvmh0amufigjkia/track_20240725_120046.gpx',
  'kamchatskiy-kamen':         'https://visitkamchatka.ru/upload/iblock/768/v00rs20svzo4g4b36agjnfkchyamacxo/Kamchatskiy_kamen_GPS_trek.gpx',
  'mayak-vertikalnyy':         'https://visitkamchatka.ru/upload/iblock/482/mwwg56woj20hhvp4zqx3dokxuwl85f6f/2024_09_07_1637_trek_vertikalnyy.gpx',
  'mys-mayachnyy':             'https://visitkamchatka.ru/upload/iblock/c0b/4dqpt6vnv4ka36nqwtlaj6f8ammxpgb4/2024_09_07_1626_mys_mayachnyy.gpx',
  'vodopad-babiy-kamen':       'https://visitkamchatka.ru/upload/iblock/267/p0x763jvu2pnxz53d673lmgz1cur6al9/Vodopad_Babiy_Kamen.gpx',
  'vodopad-snezhnyy-bars':     'https://visitkamchatka.ru/upload/iblock/c6b/wxoym1tfvompr7qgbqqoiups9amzqt2z/trek_Spokoinyi.gpx',
};

export interface GpxTrackResult {
  slug: string;
  status: 'imported' | 'no_match' | 'fetch_error' | 'no_coords';
  matched_route?: string;
  matched_route_id?: string;
  points?: number;
  has_elevation?: boolean;
  distance_km?: number;
  error?: string;
}

export interface GpxImportResult {
  total: number;
  imported: number;
  skipped: number;
  tracks: GpxTrackResult[];
  duration_ms: number;
}

function parseGpx(xml: string): number[][] {
  const re = /<(?:trkpt|rtept|wpt)\s+lat="([\d.]+)"\s+lon="([\d.]+)"[^>]*>(?:[\s\S]*?<ele>([\d.]+)<\/ele>)?/g;
  const coords: number[][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    coords.push(m[3] ? [lon, lat, parseFloat(m[3])] : [lon, lat]);
  }
  return coords;
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

export async function importVisitKamchatkaGpx(): Promise<GpxImportResult> {
  const t0 = Date.now();

  const { rows } = await pool.query<{ id: string; title: string; lat: string; lng: string }>(
    `SELECT id, title, lat::text, lng::text FROM kamchatka_routes
     WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  const routes = rows.map(r => ({ ...r, lat: parseFloat(r.lat), lng: parseFloat(r.lng) }));

  const tracks: GpxTrackResult[] = [];
  let imported = 0;

  for (const [slug, url] of Object.entries(GPX_ROUTES)) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      tracks.push({ slug, status: 'fetch_error', error: String(e) });
      continue;
    }

    if (!res.ok) {
      tracks.push({ slug, status: 'fetch_error', error: `HTTP ${res.status}` });
      continue;
    }

    const xml = await res.text();
    const coords = parseGpx(xml);

    if (coords.length < 2) {
      tracks.push({ slug, status: 'no_coords', points: coords.length });
      continue;
    }

    const startLat = coords[0][1], startLng = coords[0][0];
    let best: typeof routes[0] | null = null;
    let bestDist = 10.0;
    for (const r of routes) {
      const d = haversineKm(startLat, startLng, r.lat, r.lng);
      if (d < bestDist) { bestDist = d; best = r; }
    }

    if (!best) {
      tracks.push({ slug, status: 'no_match', points: coords.length });
      continue;
    }

    const geojson = { type: 'LineString', coordinates: coords, source: 'visitkamchatka' };
    await pool.query(
      `UPDATE kamchatka_routes SET geometry = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(geojson), best.id],
    );

    tracks.push({
      slug,
      status: 'imported',
      matched_route: best.title,
      matched_route_id: best.id,
      points: coords.length,
      has_elevation: coords[0].length >= 3,
      distance_km: Math.round(bestDist * 10) / 10,
    });
    imported++;
  }

  return {
    total: Object.keys(GPX_ROUTES).length,
    imported,
    skipped: Object.keys(GPX_ROUTES).length - imported,
    tracks,
    duration_ms: Date.now() - t0,
  };
}
