/**
 * GET /api/cron/route-geometry-census — линии, обещающие путь, которого нет.
 *
 * Владелец 21.08 открыл карту на «Трёх Братьях» и увидел ломаную от Елизово
 * через Петропавловск до входа в бухту. Корень системный: миграция 168
 * строила geometry прямыми по ВСЕМ route_waypoints, а род связи появился
 * только в 874. Там, где к маршруту привязаны соседи «в 15 км от центра»
 * (предикат 167), синтетика соединила их подряд — линия растянулась на
 * десятки километров и стала мерой пути (та же линия давала «142.3 км» на
 * полевом экране).
 *
 * Перепись меряет РАЗМАХ линии — диагональ её габаритов. Размах не равен
 * длине, но линия-монстр видна именно им: пеший маршрут не бывает шириной
 * в полуостров. Рядом — состав связей по родам (waypoint / nearby /
 * unknown): ими объясняется, откуда взялся размах.
 *
 * READ-ONLY, Bearer CRON_SECRET. `q` — фильтр по имени (разведка частного
 * случая: показывает всё найденное, включая записи без линии),
 * `min_span_km` — порог размаха для общей переписи (по умолчанию 25).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { trackEvidence } from '@/lib/routes/track-evidence';
import { lineOwnership } from '@/lib/routes/line-ownership';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Размах линии — диагональ bbox. Дёшево и достаточно, чтобы увидеть монстра. */
function spanKm(coords: number[][]): number {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const c of coords) {
    const lng = Number(c?.[0]); const lat = Number(c?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (minLat === Infinity) return 0;
  return haversineKm(minLat, minLng, maxLat, maxLng);
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const q = (sp.get('q') ?? '').trim();
  /**
   * mode=duplicates — одна линия у разных маршрутов. Это ошибка импорта по
   * определению: «Вулкан Авачинский» и «До Мутновской ГеоТЭС» несут одну
   * геометрию в 2569 вершин с одинаковыми концами, и оба зовут её своим
   * путём. Подпись линии — первая вершина, последняя и число вершин:
   * совпадение всех трёх у разных записей случайным не бывает.
   */
  const mode = (sp.get('mode') ?? '').trim();
  const rawSpan = parseFloat(sp.get('min_span_km') ?? '25');
  const minSpanKm = Number.isFinite(rawSpan) && rawSpan > 0 ? rawSpan : 25;

  try {
    const { rows } = await pool.query<{
      id: string; title: string; lat: string | null; lng: string | null;
      source: string | null; coords: unknown; distance_km: string | null;
      n_waypoint: string; n_nearby: string; n_unknown: string; wp_points: unknown;
    }>(
      `SELECT r.id::text AS id, r.title,
              r.lat::text AS lat, r.lng::text AS lng,
              r.geometry->>'source' AS source,
              r.geometry->'coordinates' AS coords,
              r.distance_km::text AS distance_km,
              COALESCE((SELECT COUNT(*) FROM route_waypoints w
                WHERE w.route_id = r.id AND w.link_kind = 'waypoint'), 0)::text AS n_waypoint,
              COALESCE((SELECT COUNT(*) FROM route_waypoints w
                WHERE w.route_id = r.id AND w.link_kind = 'nearby'), 0)::text AS n_nearby,
              COALESCE((SELECT COUNT(*) FROM route_waypoints w
                WHERE w.route_id = r.id AND COALESCE(w.link_kind, 'unknown') = 'unknown'), 0)::text AS n_unknown,
              -- Координаты ТОЛЬКО путевых мест: «рядом» линию не судит (§4.1).
              COALESCE((SELECT jsonb_agg(jsonb_build_array(p.lat::float8, p.lng::float8))
                FROM route_waypoints w JOIN places p ON p.id = w.place_id
                WHERE w.route_id = r.id AND w.link_kind = 'waypoint'
                  AND p.lat IS NOT NULL AND p.lng IS NOT NULL), '[]'::jsonb) AS wp_points
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
         AND ($1 = '' OR r.title ILIKE '%' || $1 || '%')
       ORDER BY r.title`,
      [q],
    );

    const items = rows.map(r => {
      const coords = Array.isArray(r.coords) ? (r.coords as number[][]) : null;
      const span = coords && coords.length >= 2 ? spanKm(coords) : null;
      // Улика происхождения (§12, правило 18.08): решает не имя поставщика,
      // а сама линия — высота на точках при неровном шаге. Без неё разговор
      // о роде линии сводится к мнению, а мнение здесь не судья.
      const ev = coords ? trackEvidence({ type: 'LineString', coordinates: coords }) : null;
      // Чья линия. Размах — сито, а не приговор: у кольца вокруг Толбачика
      // он законно велик, у чужой линии в двух километрах — мал. Судит
      // близость к собственной точке и к собственным путевым местам.
      const rp = r.lat !== null && r.lng !== null
        ? { lat: parseFloat(r.lat), lng: parseFloat(r.lng) } : null;
      const wps = Array.isArray(r.wp_points)
        ? (r.wp_points as number[][])
            .filter(w => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))
            .map(w => ({ lat: w[0], lng: w[1] }))
        : [];
      const own = lineOwnership({
        routePoint: rp && Number.isFinite(rp.lat) && Number.isFinite(rp.lng) ? rp : null,
        coords,
        waypoints: wps,
      });
      return {
        id: r.id,
        title: r.title,
        lat: r.lat, lng: r.lng,
        source: r.source,
        vertices: coords?.length ?? 0,
        span_km: span === null ? null : Math.round(span * 10) / 10,
        distance_km: r.distance_km,
        first: coords && coords.length > 0 ? coords[0] : null,
        last: coords && coords.length > 0 ? coords[coords.length - 1] : null,
        links: {
          waypoint: parseInt(r.n_waypoint, 10),
          nearby: parseInt(r.n_nearby, 10),
          unknown: parseInt(r.n_unknown, 10),
        },
        ownership: {
          verdict: own.verdict,
          nearest_km: own.nearestKm === null ? null : Math.round(own.nearestKm * 10) / 10,
          tail_km: own.tailKm === null ? null : Math.round(own.tailKm * 10) / 10,
          worst_waypoint_km: own.worstWaypointKm === null
            ? null : Math.round(own.worstWaypointKm * 10) / 10,
          reasons: own.reasons,
        },
        evidence: ev === null ? null : {
          verdict: ev.verdict,
          elevation_share: Math.round(ev.elevationShare * 100) / 100,
          pacing: ev.pacing,
          in_bounds: ev.inBounds,
          continuous: ev.continuous,
          reasons: ev.reasons,
        },
      };
    });

    if (mode === 'duplicates') {
      const groups = new Map<string, typeof items>();
      for (const i of items) {
        if (i.vertices < 2 || !i.first || !i.last) continue;
        const key = `${JSON.stringify(i.first)}|${JSON.stringify(i.last)}|${i.vertices}`;
        const g = groups.get(key);
        if (g) g.push(i); else groups.set(key, [i]);
      }
      const shared = [...groups.entries()]
        .filter(([, g]) => g.length > 1)
        .map(([key, g]) => ({
          signature: key,
          vertices: g[0].vertices,
          span_km: g[0].span_km,
          routes: g.map(r => ({ id: r.id, title: r.title, source: r.source, distance_km: r.distance_km })),
        }));
      return NextResponse.json({
        success: true,
        probe: 'route_geometry_census_v3',
        mode: 'duplicates',
        live_total: rows.length,
        with_line: items.filter(i => i.vertices >= 2).length,
        shared_lines: shared.length,
        routes_affected: shared.reduce((n, g) => n + g.routes.length, 0),
        items: shared.slice(0, 40),
      });
    }

    if (mode === 'ownership') {
      // Рабочий список: не «что велико», а «что не своё». Считаются все
      // живые записи; наружу идут только те, где судья назвал факт —
      // чужая линия или влитый подъезд. `unclear` не работа, а взгляд.
      const by = (v: string) => items.filter(i => i.ownership.verdict === v);
      const brief = (i: (typeof items)[number]) => ({
        id: i.id, title: i.title, source: i.source, vertices: i.vertices,
        span_km: i.span_km, distance_km: i.distance_km,
        nearest_km: i.ownership.nearest_km, tail_km: i.ownership.tail_km,
        evidence: i.evidence?.verdict ?? null,
        reasons: i.ownership.reasons,
      });
      return NextResponse.json({
        success: true,
        probe: 'route_geometry_census_v3',
        mode: 'ownership',
        live_total: rows.length,
        with_line: items.filter(i => i.vertices >= 2).length,
        counts: {
          own: by('own').length,
          own_with_approach: by('own_with_approach').length,
          foreign: by('foreign').length,
          unclear: by('unclear').length,
        },
        foreign: by('foreign').map(brief).slice(0, 30),
        with_approach: by('own_with_approach').map(brief).slice(0, 30),
      });
    }

    const offenders = q !== ''
      ? items
      : items.filter(i => i.span_km !== null && i.span_km >= minSpanKm);

    return NextResponse.json({
      success: true,
      probe: 'route_geometry_census_v3',
      live_total: rows.length,
      with_line: items.filter(i => i.vertices >= 2).length,
      offenders_total: offenders.length,
      min_span_km: minSpanKm,
      query: q,
      items: offenders.slice(0, 40),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи линий';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
