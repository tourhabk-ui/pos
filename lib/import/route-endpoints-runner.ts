/**
 * Раннер извлечения точек начала/конца маршрута из OCR-паспорта
 * (route_passport_ocr, migration 730) — партиями, тот же паттерн, что
 * passport-enrich-runner.ts: markdown → LLM (callAIWaterfall, строгий JSON)
 * → парсер → запись.
 *
 * В отличие от passport-enrich-runner (метаданные), здесь пишутся ФАКТЫ О
 * ПУТИ — новые/найденные `places` и связи `route_waypoints`. Это ближе по
 * весу к place-coords/tour-pickup, поэтому source и why обязательны на
 * партию (§5 процесса), а не только у самого промпта.
 *
 * Координату переводит из DMS КОД (parseDms), не модель: LLM отдаёт
 * дословную цитату coord_text, а не готовое число. Именованная точка без
 * координаты (`coord_text: null`) НЕ линкуется автоматически — риск тёзки
 * без координаты для проверки неприемлем (см. случай «Тюшевские»,
 * CLAUDE.md §4.1); это остаётся отдельной задачей.
 *
 * link_kind='waypoint' обоснован происхождением: официальный паспорт,
 * утверждённый дирекцией парка/министерством, называющий точку началом или
 * концом маршрута, — это улика происхождения (§4.1), не близость.
 */

import { pool } from '@/lib/db-pool';
import { callAIWaterfall } from '@/lib/ai/providers';
import { createHash } from 'node:crypto';
import {
  PASSPORT_ENDPOINTS_PROMPT,
  parsePassportEndpoints,
  parseDms,
  type PassportEndpoint,
} from '@/lib/routes/passport-endpoints';
import { haversineM } from '@/lib/routes/relief';
import {
  KRAI_LAT_MIN, KRAI_LAT_MAX, KRAI_LNG_MIN, KRAI_LNG_MAX,
} from '@/app/api/cron/place-coords/route';

const MAX_MARKDOWN_CHARS = 14000;
/** Радиус, в котором существующее место считается «тем же самым». */
const DEDUPE_RADIUS_M = 1500;

export interface RouteEndpointsParams {
  routeIds: string[];
  source: string;
  why: string;
  dryRun: boolean;
}

export type EndpointOutcome =
  | { kind: 'linked'; place_id: string; place_created: boolean; lat: number; lng: number; name: string | null }
  | { kind: 'skipped'; reason: 'no_coord' | 'coord_unparsable' | 'coord_out_of_range' | 'already_linked'; name: string | null; coord_text: string | null };

export interface RouteEndpointsDetail {
  route_id: string;
  title: string;
  status: 'linked' | 'ocr_missing' | 'parse_failed' | 'error';
  start?: EndpointOutcome;
  end?: EndpointOutcome;
  error?: string;
}

export interface RouteEndpointsResult {
  dry_run: boolean;
  source: string;
  why: string;
  processed: number;
  points_linked: number;
  places_created: number;
  details: RouteEndpointsDetail[];
}

interface Row {
  route_id: string;
  title: string;
  markdown: string | null;
  pdf_url: string | null;
}

function inKrai(lat: number, lng: number): boolean {
  return lat >= KRAI_LAT_MIN && lat <= KRAI_LAT_MAX && lng >= KRAI_LNG_MIN && lng <= KRAI_LNG_MAX;
}

/** Детерминированный id: повторный прогон по той же точке не плодит дублей. */
function placeId(routeId: string, which: 'start' | 'end', lat: number, lng: number): string {
  return createHash('md5')
    .update(`route-endpoint:${routeId}:${which}:${lat.toFixed(5)}:${lng.toFixed(5)}`)
    .digest('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

async function resolveEndpoint(
  point: PassportEndpoint,
  routeId: string,
  which: 'start' | 'end',
  pdfUrl: string | null,
  dryRun: boolean,
): Promise<EndpointOutcome> {
  if (!point.coord_text) {
    return { kind: 'skipped', reason: 'no_coord', name: point.name, coord_text: null };
  }
  const coord = parseDms(point.coord_text);
  if (!coord) {
    return { kind: 'skipped', reason: 'coord_unparsable', name: point.name, coord_text: point.coord_text };
  }
  if (!inKrai(coord.lat, coord.lng)) {
    return { kind: 'skipped', reason: 'coord_out_of_range', name: point.name, coord_text: point.coord_text };
  }

  // Существующее место рядом — не заводим дубль. Грубый прямоугольник в
  // запросе (дёшево посчитать), точная дистанция — haversine в коде.
  const deg = DEDUPE_RADIUS_M / 111_000;
  const { rows: nearby } = await pool.query<{ id: string; lat: string; lng: string }>(
    `SELECT id, lat::text, lng::text FROM places
      WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
        AND merged_into_id IS NULL AND is_visible = true`,
    [coord.lat - deg, coord.lat + deg, coord.lng - deg, coord.lng + deg],
  );
  const existing = nearby.find(
    (p) => haversineM(coord, { lat: parseFloat(p.lat), lng: parseFloat(p.lng) }) <= DEDUPE_RADIUS_M,
  );

  const id = existing?.id ?? placeId(routeId, which, coord.lat, coord.lng);

  if (!dryRun) {
    if (!existing) {
      await pool.query(
        // places.id — TEXT NOT NULL без DEFAULT (тот же урок, что в
        // idilesom-importer.ts): без явного id вставка падает на not-null.
        `INSERT INTO places (id, ark_id, name, lat, lng, source_url, source_name, is_visible)
         VALUES ($1, $1::uuid, $2, $3::numeric, $4::numeric, $5, 'visitkamchatka.ru', true)
         ON CONFLICT (id) DO NOTHING`,
        [id, point.name ?? `Точка маршрута (${which === 'start' ? 'начало' : 'конец'})`, coord.lat, coord.lng, pdfUrl],
      );
    }
    const posRes = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM route_waypoints WHERE route_id = $1::uuid`,
      [routeId],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, "position", is_start, is_end, link_kind, link_kind_at)
       VALUES ($1::uuid, $2, $3, $4, $5, 'waypoint', NOW())
       ON CONFLICT (route_id, place_id) DO NOTHING`,
      [routeId, id, Number(posRes.rows[0]?.n ?? 0), which === 'start', which === 'end'],
    );
  }

  return { kind: 'linked', place_id: id, place_created: !existing, lat: coord.lat, lng: coord.lng, name: point.name };
}

export async function runRouteEndpoints(params: RouteEndpointsParams): Promise<RouteEndpointsResult> {
  const { routeIds, source, why, dryRun } = params;

  const { rows } = await pool.query<Row>(
    `SELECT r.id::text AS route_id, r.title,
            o.markdown, COALESCE(r.official_passport_url, r.pdf_url) AS pdf_url
       FROM kamchatka_routes r
       LEFT JOIN route_passport_ocr o ON o.route_id = r.id
      WHERE r.id::text = ANY($1::text[])`,
    [routeIds],
  );

  const details: RouteEndpointsDetail[] = [];
  let pointsLinked = 0;
  let placesCreated = 0;

  for (const r of rows) {
    if (!r.markdown) {
      details.push({ route_id: r.route_id, title: r.title, status: 'ocr_missing' });
      continue;
    }
    try {
      const raw = await callAIWaterfall([
        { role: 'system', content: PASSPORT_ENDPOINTS_PROMPT },
        { role: 'user', content: r.markdown.slice(0, MAX_MARKDOWN_CHARS) },
      ]);
      const endpoints = parsePassportEndpoints(raw);
      if (!endpoints) {
        details.push({ route_id: r.route_id, title: r.title, status: 'parse_failed' });
        continue;
      }

      const start = await resolveEndpoint(endpoints.start, r.route_id, 'start', r.pdf_url, dryRun);
      const end = await resolveEndpoint(endpoints.end, r.route_id, 'end', r.pdf_url, dryRun);
      for (const o of [start, end]) {
        if (o.kind === 'linked') {
          pointsLinked++;
          if (o.place_created) placesCreated++;
        }
      }
      details.push({ route_id: r.route_id, title: r.title, status: 'linked', start, end });
    } catch (err) {
      details.push({
        route_id: r.route_id, title: r.title, status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dry_run: dryRun,
    source,
    why,
    processed: rows.length,
    points_linked: pointsLinked,
    places_created: placesCreated,
    details,
  };
}
