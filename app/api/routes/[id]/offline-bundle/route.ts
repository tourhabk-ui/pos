import { query } from '@/lib/database';
import { lonToTile, latToTile, TILE_HOST } from '@/lib/offline/tiles';
import { planCorridor, estimateTilesMb, CORRIDOR_ZOOMS, type TrackPoint } from '@/lib/offline/route-corridor';

// AUTH: Public — данные маршрута публичные, тайлы публичные
export const dynamic = 'force-dynamic';

// Прямоугольник остался ЗАПАСНЫМ вариантом — для точек-сущностей без трека
// (гора, озеро): там коридору неоткуда взяться, и квадрат вокруг координаты
// честен. Основной путь — коридор по треку, см. lib/offline/route-corridor.
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

  const [routeRes, wpRes, alertRes] = await Promise.all([
    query(
      `SELECT id, title, description, lat, lng, difficulty, distance_km,
              elevation_gain_m, duration_hours, season, hazards, equipment,
              mchs_registration_required, mchs_phone, park_name, geometry
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
    // Действующие предупреждения по точкам маршрута.
    //
    // До этого офлайн-пакет нёс карту, трек, снаряжение и телефон МЧС — но
    // ни одного слова об обстановке. Турист скачивал маршрут перед выходом и
    // уносил в поле всё, кроме знания о пожаре, закрытой дороге или пеплопаде.
    // Именно там, где связи нет, это знание и нужно.
    //
    // Берём через точки маршрута: у алерта зона, у точки — своя строка статуса,
    // связь уже посчитана кроном safety-ingest. DISTINCT — один и тот же алерт
    // висит на нескольких точках маршрута.
    query(
      `SELECT DISTINCT ea.alert_type, ea.severity, ea.title, ea.expires_at::text
         FROM route_waypoints rw
         JOIN places p            ON p.id = rw.place_id
         JOIN location_real_time_status lrs ON lrs.agent_route_id = p.ark_id
         JOIN external_alerts ea  ON ea.title = ANY(lrs.active_alerts)
        WHERE rw.route_id = $1
          AND ea.expires_at > NOW()
        ORDER BY ea.severity DESC
        LIMIT 20`,
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
              FALSE AS mchs_registration_required, NULL AS mchs_phone, NULL AS park_name,
              NULL AS geometry
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

  /**
   * Коридор по треку — основной путь.
   *
   * Прямоугольник вокруг точек качал не ту карту: у маршрута с одной точкой
   * трек уходил за край скачанного, у длинного — три четверти пакета уходило
   * на море и тундру. Вдобавок потолок в 2000 тайлов срезал ХВОСТ списка, а
   * список шёл от грубых зумов к детальным: первым отваливался единственный
   * зум, по которому можно идти ногами. Молча.
   *
   * Коридор решает всё три: вчетверо меньше веса, детализация до 15 зума и
   * отказ, названный вслух.
   */
  const geo = r.geometry as { coordinates?: unknown } | null;
  const track: TrackPoint[] = Array.isArray(geo?.coordinates)
    ? (geo.coordinates as unknown[]).flatMap((c): TrackPoint[] => {
        if (!Array.isArray(c) || c.length < 2) return [];
        const lng = Number(c[0]);
        const lat = Number(c[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [[lat, lng]] : [];
      })
    : [];

  const corridor = track.length >= 2 ? planCorridor(track) : null;
  const tileUrls = corridor
    ? corridor.urls
    : tilesForBbox(bbox.north, bbox.south, bbox.east, bbox.west).slice(0, MAX_TILES);

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
    alerts: alertRes.rows.map(a => ({
      type:     a.alert_type,
      severity: Number(a.severity),
      title:    a.title,
      until:    a.expires_at,
    })),
    // Момент сборки пакета. Офлайн-данные стареют молча: без отметки турист
    // на третий день не отличит вчерашнюю обстановку от сегодняшней и решит,
    // что «предупреждений нет». Пусть решает, глядя на дату.
    built_at: new Date().toISOString(),
    bbox,
    tile_urls: tileUrls,
    tile_count: tileUrls.length,
    zoom_levels: corridor ? corridor.zooms : ZOOMS,
    // Чем покрыта карта — коридором по треку или квадратом вокруг точки.
    // Экран говорит это человеку: «полоса 2 км вдоль маршрута» и «квадрат
    // вокруг места» — разные обещания, и путать их нельзя.
    tile_coverage: corridor ? 'corridor' : 'bbox',
    corridor_buffer_km: corridor ? corridor.bufferKm : null,
    // Обещанный вес — до скачивания, чтобы человек решал, ждать или выходить.
    // На пути без коридора здесь стоял null: клиент превращал его в ноль, и
    // кнопка предлагала «Сохранить карту · 0 МБ» перед закачкой на десятки
    // мегабайт (квадрат режется по MAX_TILES=2000). Считаем по тому же
    // списку тайлов, что и отдаём, — обещание и работа из одного источника.
    estimate_mb: corridor ? corridor.estimateMb : estimateTilesMb(tileUrls),
    // Отказ называем вслух: молчаливый срез — это карта, на которую человек
    // рассчитывал и которой не будет.
    dropped_zooms: corridor ? corridor.droppedZooms : [],
    max_zoom: corridor ? Math.max(...corridor.zooms) : Math.max(...ZOOMS),
    all_zooms: CORRIDOR_ZOOMS,
  });
}
