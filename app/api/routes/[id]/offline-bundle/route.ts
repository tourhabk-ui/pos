import { query } from '@/lib/database';
import { lonToTile, latToTile, TILE_HOST } from '@/lib/offline/tiles';

// AUTH: Public — данные маршрута публичные, тайлы публичные
export const dynamic = 'force-dynamic';

const ZOOMS = [10, 11, 12]; // 7-9 уже pre-cached глобально по всей Камчатке
const MAX_TILES = 2000;      // защита от огромных bbox
const PAD_LAT = 0.135;       // ~15 км отступ
const PAD_LNG = 0.18;

function tilesForBbox(n: number, s: number, e: number, w: number): string[] {
  const urls: string[] = [];
  for (const z of ZOOMS) {
    for (let x = lonToTile(w, z); x <= lonToTile(e, z); x++) {
      for (let y = latToTile(n, z); y <= latToTile(s, z); y++) {
        urls.push(`https://${TILE_HOST}/${z}/${x}/${y}.png`);
      }
    }
  }
  return urls;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'Invalid ID' }, { status: 400 });
  }

  const [routeRes, wpRes] = await Promise.all([
    query(
      `SELECT id, title, description, lat, lng, difficulty, distance_km,
              elevation_gain_m, duration_hours, season, hazards, equipment,
              mchs_registration_required, mchs_phone, park_name
       FROM kamchatka_routes WHERE id = $1 AND (is_visible = TRUE OR is_visible IS NULL)`,
      [id],
    ),
    query(
      `SELECT p.lat, p.lng, p.name AS place_name, rw.position
       FROM route_waypoints rw
       JOIN places p ON p.id = rw.place_id
       WHERE rw.route_id = $1 AND p.lat IS NOT NULL AND p.lng IS NOT NULL
       ORDER BY rw.position`,
      [id],
    ),
  ]);

  let r = routeRes.rows[0];

  // Страница /routes/[id] показывает и точки-сущности из agent_route_knowledge
  // (горные массивы, озёра и т.п.), которых нет в v_kamchatka_routes_api.
  // Для них офлайн-пакет — тайлы вокруг координат точки, без waypoints.
  if (!r) {
    const arkRes = await query(
      `SELECT id, title, description, lat, lng,
              NULL AS difficulty, NULL AS distance_km, NULL AS elevation_gain_m,
              NULL AS duration_hours, NULL AS season,
              NULL AS hazards, NULL AS equipment,
              FALSE AS mchs_registration_required, NULL AS mchs_phone, NULL AS park_name
       FROM agent_route_knowledge
       WHERE id = $1 AND is_visible = TRUE AND lat IS NOT NULL AND lng IS NOT NULL`,
      [id],
    );
    r = arkRes.rows[0];
  }

  if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

  const lats: number[] = [];
  const lngs: number[] = [];
  if (r.lat) lats.push(Number(r.lat));
  if (r.lng) lngs.push(Number(r.lng));
  for (const wp of wpRes.rows) {
    lats.push(Number(wp.lat));
    lngs.push(Number(wp.lng));
  }

  if (lats.length === 0) return Response.json({ error: 'No coordinates' }, { status: 422 });

  const bbox = {
    north: Math.max(...lats) + PAD_LAT,
    south: Math.min(...lats) - PAD_LAT,
    east:  Math.max(...lngs) + PAD_LNG,
    west:  Math.min(...lngs) - PAD_LNG,
  };

  const tileUrls = tilesForBbox(bbox.north, bbox.south, bbox.east, bbox.west).slice(0, MAX_TILES);

  return Response.json({
    route: {
      id: r.id, title: r.title, description: r.description,
      lat: r.lat, lng: r.lng, difficulty: r.difficulty,
      distance_km: r.distance_km, elevation_gain_m: r.elevation_gain_m,
      duration_hours: r.duration_hours, season: r.season,
      hazards: r.hazards, equipment: r.equipment,
      mchs_registration_required: r.mchs_registration_required,
      mchs_phone: r.mchs_phone, park_name: r.park_name,
    },
    waypoints: wpRes.rows.map(wp => ({
      position: wp.position,
      name: wp.place_name,
      lat: Number(wp.lat),
      lng: Number(wp.lng),
    })),
    bbox,
    tile_urls: tileUrls,
    tile_count: tileUrls.length,
    zoom_levels: ZOOMS,
  });
}
