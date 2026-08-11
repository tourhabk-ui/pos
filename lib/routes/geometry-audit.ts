/**
 * lib/routes/geometry-audit.ts
 *
 * Сколько маршрутов сами себе противоречат — и чем именно.
 *
 * Владелец просит перенести все маршруты в единую базу, «как у maps.me».
 * Направление верное, но у них единая база — это не одно хранилище, а ОДИН
 * ИСТОЧНИК ИСТИНЫ: геометрия и точки приходят из одного графа OSM и разойтись
 * не могут в принципе. У нас источников два и они независимы:
 *
 *   линия  — `kamchatka_routes.geometry`;
 *   точки  — `route_waypoints` → `places`.
 *
 * Отсюда «Мыс Маячный» на южном берегу входа в Авачинскую бухту при треке по
 * северному: экран уверенно считал «20.3 км» и «придём через 5 ч 45 м» через
 * воду. Заплатка (#1120) снимает цифру, но причина в данных.
 *
 * Переносить 421 маршрут вслепую нельзя: это данные, от которых зависит
 * безопасность, и «перебрать всё» без понимания, что именно сломано, — то же
 * действие без измерения, которое мы весь день ловим. Сначала перепись.
 *
 * READ-ONLY: ничего не пишет.
 */

import { pool } from '@/lib/db-pool';
import { trackFidelity } from '@/lib/routes/track-fidelity';
import { projectOnTrack, DATA_CONFLICT_KM } from '@/lib/on-route/approach';
import { isScatteredCollection, boundingSpanKm, maxSegmentKm } from '@/lib/routes/geometry-compact';
import { waypointFit, type WaypointFitVerdict } from '@/lib/routes/shape-match';

/** Сколько маршрутов считать одновременно. */
const CONCURRENCY = 8;

/**
 * Прыжок в линии, за которым она перестаёт быть путём, км.
 *
 * То же число, которым судит `isScatteredCollection` на экране выбора —
 * своего порога не заводим. Отличается только НАБОР признаков: у линии
 * габарит не улика (см. ниже), у набора точек — улика.
 */
const COLLECTION_JUMP_KM = 25;

export interface RouteFlaw {
  id: string;
  title: string;
  /** Худший отрыв точки от собственной линии, км. Мера БЕЗ порядка. */
  worstOffTrackKm: number;
  /** Худший отход точки от линии, метры — та же величина точнее. */
  maxOffsetM: number | null;
  waypoints: number;
  trackPoints: number;
}

export interface CollectionFlaw {
  id: string;
  title: string;
  /** Габарит набора, км: сколько края он накрывает. */
  spanKm: number;
  waypoints: number;
  /** По чему опознана подборка. */
  by: 'waypoints' | 'geometry';
}

export interface GeometryAudit {
  routes_total: number;
  routes_counted: number;
  /** Линии нет вовсе — вести не по чему. */
  no_geometry: number;
  /** Линия есть, но точек маршрута нет: сверить не с чем. */
  no_waypoints: number;
  /**
   * Линия — набросок, а не снятый трек. Считается ТЕМ ЖЕ правилом, что рисует
   * её пунктиром на экране (lib/routes/track-fidelity), а не своим порогом.
   */
  sketch_geometry: number;
  surveyed_geometry: number;
  /** Хотя бы одна точка дальше порога от собственной линии. */
  conflicting: number;
  /** Все точки лежат на линии. */
  consistent: number;
  /** Порог, по которому считался конфликт. */
  conflict_km: number;
  /**
   * Не маршрут, а подборка мест: точки разбросаны по краю, пути между ними
   * нет по смыслу.
   *
   * Считается ТЕМ ЖЕ правилом, что уже не даёт предлагать «идти по маршруту»
   * на экране выбора (`isScatteredCollection`: сегмент длиннее 25 км ИЛИ
   * габарит набора шире 25 км). Своего порога не заводим: второе правило об
   * одном и том же разойдётся с первым — это мы уже проходили с чисткой
   * алертов.
   *
   * Разделение обязано идти ДО сведения данных в единый слой. Иначе реестр
   * честно запишет геометрию объекту, у которого пути нет вовсе, и закрепит
   * бессмыслицу вместо того, чтобы её убрать.
   */
  collections: number;
  /** Из них подборка видна по разбросу ТОЧЕК. */
  collections_by_waypoints: number;
  /** Из них подборка видна по разбросу самой ЛИНИИ (точек могло не быть). */
  collections_by_geometry: number;
  /** Худшие подборки: по ним видно, что это тематические наборы, а не пути. */
  worst_collections: CollectionFlaw[];
  /**
   * Как путевые точки сидят на линии — отход И ПОРЯДОК.
   *
   * Прежняя мера («самая дальняя точка от линии») верна, но не знает порядка:
   * трек, проходящий те же места в обратную сторону, по ней неотличим от
   * правильного. Порядок считается рядом, а не вместо: обе величины остаются
   * в ответе, и видно, какая из них сработала.
   *
   * Каноническую меру похожести кривых (расстояние Фреше) я пробовал первой —
   * она на этих данных меряет плотность разметки, а не расхождение путей
   * (почему именно — в lib/routes/shape-match.ts).
   */
  by_shape: Record<WaypointFitVerdict, number>;
  /** Маршруты, где точки на линии, но ПОРЯДОК нарушен — прежняя мера слепа. */
  worst_order: Array<{ id: string; title: string; inversions: number; waypoints: number; coverage: number | null }>;
  /** Худшие расхождения — с них и начинать разбор. */
  worst: RouteFlaw[];
  duration_ms: number;
}

interface RouteRow { id: string; title: string | null; geometry: unknown }
interface WpRow { route_id: string; lat: string | null; lng: string | null }

/** GeoJSON LineString → точки. Формат тот же, что читает offline-bundle. */
export function geometryToTrack(geometry: unknown): Array<{ lat: number; lng: number }> {
  const geo = geometry as { coordinates?: unknown } | null;
  if (!Array.isArray(geo?.coordinates)) return [];
  const out: Array<{ lat: number; lng: number }> = [];
  for (const c of geo.coordinates as unknown[]) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function runGeometryAudit(limit?: number): Promise<GeometryAudit> {
  const startedAt = Date.now();

  const totalRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)`,
  );
  const routes_total = parseInt(totalRes.rows[0]?.n ?? '0', 10);

  const listRes = await pool.query<RouteRow>(
    limit
      ? `SELECT id::text, title, geometry FROM kamchatka_routes
          WHERE (is_visible = TRUE OR is_visible IS NULL) ORDER BY id LIMIT $1`
      : `SELECT id::text, title, geometry FROM kamchatka_routes
          WHERE (is_visible = TRUE OR is_visible IS NULL) ORDER BY id`,
    limit ? [limit] : [],
  );

  // Точки берутся одним запросом на всех: 421 отдельный запрос ради того же
  // ответа — трата, а не тщательность.
  const wpRes = await pool.query<WpRow>(
    `SELECT rw.route_id::text, p.lat::text, p.lng::text
       FROM route_waypoints rw
       JOIN places p ON p.id = rw.place_id
      WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL`,
  );
  const byRoute = new Map<string, Array<{ lat: number; lng: number }>>();
  for (const w of wpRes.rows) {
    const lat = Number(w.lat), lng = Number(w.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const arr = byRoute.get(w.route_id) ?? [];
    arr.push({ lat, lng });
    byRoute.set(w.route_id, arr);
  }

  let no_geometry = 0, no_waypoints = 0, sketch_geometry = 0, surveyed_geometry = 0;
  let conflicting = 0, consistent = 0;
  let collections = 0, collections_by_waypoints = 0, collections_by_geometry = 0;
  const by_shape: Record<WaypointFitVerdict, number> = {
    fits: 0, out_of_order: 0, off_track: 0, unknown: 0,
  };
  const flaws: RouteFlaw[] = [];
  const collectionFlaws: CollectionFlaw[] = [];
  const orderCases: Array<{ id: string; title: string; inversions: number; waypoints: number; coverage: number | null }> = [];

  await mapLimit(listRes.rows, CONCURRENCY, async (r) => {
    const track = geometryToTrack(r.geometry);
    if (track.length < 2) { no_geometry += 1; return; }

    // trackFidelity считает по парам [широта, долгота] — тому же виду, что
    // приходит с экрана; форму приводим здесь, правило не дублируем.
    const pairs = track.map((p) => [p.lat, p.lng] as [number, number]);
    if (trackFidelity(pairs) === 'sketch') sketch_geometry += 1;
    else surveyed_geometry += 1;

    const wps = byRoute.get(r.id) ?? [];
    const wpPairs = wps.map((w) => [w.lat, w.lng] as [number, number]);

    // Подборка, а не маршрут: проверяется ДО расхождения линии и точек.
    // Иначе объект без пути по смыслу попадёт в «конфликтующие маршруты» и
    // будет числиться чинимым — а чинить там нечего, там другая сущность.
    // У НАБОРА ТОЧЕК считаются оба признака: места по краю и прыгают, и
    // разбросаны — габарит там говорит о разбросанности.
    const scatteredWps = wpPairs.length >= 2 && isScatteredCollection(wpPairs);
    // У СПЛОШНОЙ ЛИНИИ габарит не значит ничего: он равен длине маршрута.
    // Первый прогон это и показал — «Сплав по реке Камчатка. Путешествие
    // длиной в 500 км» (габарит 282 км), «Зимник Анавгай — Тигиль» (192),
    // «Пешеходный поход 5 к.с. по северу Камчатки» (184) были объявлены
    // подборками. Это настоящие длинные маршруты, и накрывать сотни
    // километров — их работа, а не признак разбросанности.
    //
    // Подборку от длинного пути отличает НЕПРЕРЫВНОСТЬ: у сплава шаг между
    // точками метры, у подборки — прыжок в десятки километров. Поэтому для
    // линии берётся только тот признак, который здесь что-то значит.
    const scatteredGeo = maxSegmentKm(pairs) > COLLECTION_JUMP_KM;
    if (scatteredWps || scatteredGeo) {
      collections += 1;
      if (scatteredWps) collections_by_waypoints += 1;
      else collections_by_geometry += 1;
      collectionFlaws.push({
        id: r.id,
        title: r.title ?? '(без названия)',
        spanKm: Math.round(boundingSpanKm(scatteredWps ? wpPairs : pairs)),
        waypoints: wps.length,
        by: scatteredWps ? 'waypoints' : 'geometry',
      });
      return;
    }

    if (wps.length === 0) { no_waypoints += 1; return; }

    let worst = 0;
    for (const w of wps) {
      const pr = projectOnTrack(w, track);
      if (pr && pr.offTrackKm > worst) worst = pr.offTrackKm;
    }

    // Как точки сидят на линии: отход И порядок. Точки приходят упорядоченные
    // по route_waypoints.position — на случайной перестановке порядок был бы
    // не измерением, а шумом.
    const fit = waypointFit(track, wps);
    by_shape[fit.verdict] += 1;
    if (fit.inversions !== null && fit.inversions > 0) {
      orderCases.push({
        id: r.id,
        title: r.title ?? '(без названия)',
        inversions: fit.inversions,
        waypoints: wps.length,
        coverage: fit.coverage,
      });
    }

    if (worst > DATA_CONFLICT_KM) {
      conflicting += 1;
      flaws.push({
        id: r.id,
        title: r.title ?? '(без названия)',
        worstOffTrackKm: Math.round(worst * 10) / 10,
        maxOffsetM: fit.maxOffsetM,
        waypoints: wps.length,
        trackPoints: track.length,
      });
    } else {
      consistent += 1;
    }
  });

  flaws.sort((a, b) => b.worstOffTrackKm - a.worstOffTrackKm);
  collectionFlaws.sort((a, b) => b.spanKm - a.spanKm);
  orderCases.sort((a, b) => b.inversions - a.inversions);

  return {
    routes_total,
    routes_counted: listRes.rows.length,
    no_geometry,
    no_waypoints,
    sketch_geometry,
    surveyed_geometry,
    conflicting,
    consistent,
    conflict_km: DATA_CONFLICT_KM,
    collections,
    collections_by_waypoints,
    collections_by_geometry,
    worst_collections: collectionFlaws.slice(0, 15),
    by_shape,
    worst_order: orderCases.slice(0, 10),
    worst: flaws.slice(0, 15),
    duration_ms: Date.now() - startedAt,
  };
}
