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
 *
 * ── Что показал сухой прогон первой партии (03.09) ───────────────────────
 *
 * Из десяти маршрутов у ПЯТИ начало и конец пришли с одной и той же
 * координатой до седьмого знака, и ни у одной точки не было имени. Это не
 * «две точки маршрута» — это одна точка, названная дважды, и она бы:
 *
 *   - прошла черту `MIN_ROUTE_WAYPOINTS = 2`, не добавив ни грамма знания
 *     о пути (порог вырос бы, а сверять линию по-прежнему было бы не с чем);
 *   - завела в `places` — мастер-таблицу географии — заглушки вида «Точка
 *     маршрута (начало)», то есть выдуманные имена там, где паспорт имени
 *     не назвал (§4.0: пустая строка лучше придуманной).
 *
 * Отсюда два детерминированных отказа, а не правки промпта: `same_point`
 * (начало и конец ближе SAME_POINT_M) и `no_name` (имени нет и рядом нет
 * существующего места, к которому можно привязаться честно). Оба —
 * «не смог», а не «сделал».
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
/**
 * Ближе этого начало и конец — одна точка, названная дважды.
 *
 * 50 метров, а не ноль: паспорт пишет координату в градусах-минутах-секундах,
 * и одна и та же точка в двух местах текста округляется по-разному. Ноль
 * ловил бы только побайтовое совпадение и пропускал бы ту же беду на секунду
 * в сторону.
 */
const SAME_POINT_M = 50;

export interface RouteEndpointsParams {
  routeIds: string[];
  source: string;
  why: string;
  dryRun: boolean;
}

export type EndpointSkipReason =
  | 'no_coord' | 'coord_unparsable' | 'coord_out_of_range' | 'already_linked'
  /** Имени нет, и рядом нет места, к которому можно привязаться честно. */
  | 'no_name'
  /** Начало и конец — одна и та же точка (см. SAME_POINT_M). */
  | 'same_point';

export type EndpointOutcome =
  | { kind: 'linked'; place_id: string; place_created: boolean; lat: number; lng: number; name: string | null }
  | { kind: 'skipped'; reason: EndpointSkipReason; name: string | null; coord_text: string | null };

export interface RouteEndpointsDetail {
  route_id: string;
  title: string;
  status: 'linked' | 'ocr_missing' | 'parse_failed' | 'endpoints_identical' | 'error';
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

  // Безымянную точку заводить нельзя: `places` — мастер-таблица географии, и
  // «Точка маршрута (начало)» в ней это выдуманное имя, по которому потом
  // сличают дубли (§4.1). Привязка к УЖЕ существующему месту рядом честна:
  // имя там настоящее, его дал не мы.
  if (!existing && !point.name?.trim()) {
    return { kind: 'skipped', reason: 'no_name', name: point.name, coord_text: point.coord_text };
  }

  const id = existing?.id ?? placeId(routeId, which, coord.lat, coord.lng);

  if (!dryRun) {
    if (!existing) {
      await pool.query(
        // places.id — TEXT NOT NULL без DEFAULT (тот же урок, что в
        // idilesom-importer.ts): без явного id вставка падает на not-null.
        //
        // $1 использован дважды с РАЗНЫМ приведением (id — text, ark_id —
        // uuid). Без явного ::text на первом употреблении PostgreSQL не
        // может согласовать вывод типа параметра между «голым» $1 (столбец
        // text) и $1::uuid — 42P08 «inconsistent types deduced for
        // parameter $1», проверено пробой 202 (CLAUDE.md §4.0, случай
        // 24.08: тот же класс дефекта, другая форма запроса).
        //
        // location_type NOT NULL — places_shape_check (migration 650).
        // Тип точки паспорт не называет (это развилка/кордон/стоянка, не
        // геообъект вроде вулкана или озера) — 'other', та же честная
        // заглушка «тип неизвестен», что у kamchatkaland-importer.ts и
        // ELSE-ветки инференса в 650_cleanup_places_phase1.sql. Проверено
        // пробой 203: без него вставка падает на CHECK.
        `INSERT INTO places (id, ark_id, name, lat, lng, location_type, source_url, source_name, is_visible)
         VALUES ($1::text, $1::uuid, $2, $3::numeric, $4::numeric, 'other', $5, 'visitkamchatka.ru', true)
         ON CONFLICT (id) DO NOTHING`,
        // Имя здесь всегда есть: безымянная точка отсеяна выше (`no_name`).
        // Прежняя заглушка «Точка маршрута (начало)» убрана 03.09 — она и
        // была тем выдуманным именем, ради которого правило написано.
        [id, point.name?.trim(), coord.lat, coord.lng, pdfUrl],
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

      // Одна точка, названная дважды, — не начало и конец. Проверяется ДО
      // записи и до дедупа: на живой базе второе место схлопнулось бы в
      // первое (радиус 1500 м), маршрут получил бы один waypoint вместо
      // двух, а счётчик отчитался бы за два — то есть отчёт разошёлся бы с
      // базой молча.
      const startCoord = endpoints.start.coord_text ? parseDms(endpoints.start.coord_text) : null;
      const endCoord = endpoints.end.coord_text ? parseDms(endpoints.end.coord_text) : null;
      if (startCoord && endCoord && haversineM(startCoord, endCoord) <= SAME_POINT_M) {
        details.push({
          route_id: r.route_id, title: r.title, status: 'endpoints_identical',
          start: { kind: 'skipped', reason: 'same_point', name: endpoints.start.name, coord_text: endpoints.start.coord_text },
          end: { kind: 'skipped', reason: 'same_point', name: endpoints.end.name, coord_text: endpoints.end.coord_text },
        });
        continue;
      }

      const start = await resolveEndpoint(endpoints.start, r.route_id, 'start', r.pdf_url, dryRun);
      const end = await resolveEndpoint(endpoints.end, r.route_id, 'end', r.pdf_url, dryRun);
      // Считаем по РАЗНЫМ местам: если дедуп свёл обе точки к одному месту,
      // связь у маршрута будет одна (ON CONFLICT DO NOTHING), и счётчик «2»
      // был бы отчётом о работе, которой не было.
      const linkedIds = new Set(
        [start, end].filter(o => o.kind === 'linked').map(o => (o as { place_id: string }).place_id),
      );
      pointsLinked += linkedIds.size;
      for (const o of [start, end]) {
        if (o.kind === 'linked' && o.place_created) placesCreated++;
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
