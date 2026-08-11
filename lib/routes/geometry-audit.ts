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
import { boundingSpanKm } from '@/lib/routes/geometry-compact';
import { waypointFit, routeIntegrity, pointsAreCollection, type WaypointFitVerdict } from '@/lib/routes/shape-match';

/** Сколько маршрутов считать одновременно. */
const CONCURRENCY = 8;

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

/**
 * Какие ФОРМЫ геометрии реально лежат в базе.
 *
 * Повод — план «корректное чтение геометрии в /planning?mode=trail» (11.08).
 * Проверка по коду подтвердила две его посылки: `extractTrackpoints` читает
 * только голый LineString (Feature, FeatureCollection, MultiLineString дают
 * пустой массив), и диапазоны координат не проверяются вовсе — только
 * `Number.isFinite`.
 *
 * Но план предлагает начать с нормализатора обёрток, а это работа под
 * случай, которого может не быть: вся геометрия у нас либо синтетический
 * LineString из путевых точек (миграция 168), либо KML-импорт — тоже
 * LineString. Значит первым делом надо СОСЧИТАТЬ формы, а не писать разбор
 * для гипотезы.
 *
 * Обратное тоже верно и не зависит от этого числа: `track: null` сейчас
 * означает и «геометрии нет», и «формат не поддержан», и «координаты
 * негодные» — три разных факта одним значением. Это тот же дефект, что
 * `Number(null) === 0`, только в контракте API.
 */
export interface GeometryShapes {
  /** Сколько записей каждой формы: LineString, Feature, MultiLineString, … */
  by_type: Record<string, number>;
  /** Обёртки, которые сейчас дают пустой трек молча. */
  unsupported: number;
  /**
   * Линия есть, но вести по ней некуда: координат нет вовсе или одна точка.
   *
   * Считается отдельно от «геометрии нет»: для API это разные факты, а
   * сейчас оба приходят как `track: null`. Из одной точки не построить ни
   * пути, ни направления — но запись при этом выглядит как «геометрия есть».
   */
  empty_or_single: number;
  /** Координаты вне диапазонов широты/долготы. */
  out_of_range: number;
  /**
   * ОДНОЗНАЧНО перепутанный порядок осей.
   *
   * Условие строгое: ВСЕ негодные точки записи объясняются перестановкой —
   * как [lng, lat] не проходят, как [lat, lng] проходят. Если хотя бы одна
   * негодная точка не объясняется, запись сюда не попадает: смесь мусора и
   * перестановки — это разбор человека, а не повод для правила.
   *
   * Считается, но НЕ чинится: молча переставить оси значит заменить один
   * неизвестный факт другим.
   */
  suspect_swapped: number;
  /** Образцы: id и форма — по ним видно, о чём речь. */
  samples: Array<{ id: string; title: string; type: string; note: string }>;
}

export interface GeometryAudit {
  routes_total: number;
  routes_counted: number;
  /** Формы геометрии — см. GeometryShapes. */
  shapes: GeometryShapes;
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

  // ── Перепись ФОРМ геометрии ───────────────────────────────────────────────
  //
  // Читаем то, что лежит, а не то, что ожидаем прочитать. Порядок именно
  // такой: сперва узнать, встречаются ли обёртки вообще, и только потом
  // решать, писать ли для них разбор.
  const shapes: GeometryShapes = {
    by_type: {}, unsupported: 0, empty_or_single: 0,
    out_of_range: 0, suspect_swapped: 0, samples: [],
  };
  const inLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
  const inLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;

  for (const row of listRes.rows) {
    const g = row.geometry as { type?: string; coordinates?: unknown } | null;
    const type = g?.type ?? '(нет геометрии)';
    shapes.by_type[type] = (shapes.by_type[type] ?? 0) + 1;

    if (g && type !== 'LineString' && type !== '(нет геометрии)') {
      shapes.unsupported += 1;
      if (shapes.samples.length < 12) {
        shapes.samples.push({
          id: row.id, title: row.title ?? '(без названия)', type,
          note: 'обёртка не читается — трек выйдет пустым, а причина не назовётся',
        });
      }
      continue;
    }

    const coords = Array.isArray(g?.coordinates) ? (g!.coordinates as unknown[]) : null;
    if (!coords) continue;

    // Линия есть, а вести по ней некуда. Для API это НЕ то же самое, что
    // «геометрии нет», хотя сейчас оба приходят как track: null.
    if (coords.length < 2) {
      shapes.empty_or_single += 1;
      if (shapes.samples.length < 12) {
        shapes.samples.push({
          id: row.id, title: row.title ?? '(без названия)', type,
          note: coords.length === 0 ? 'линия объявлена, координат нет' : 'одна точка — пути нет',
        });
      }
      continue;
    }

    let bad = 0, swapped = 0;
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const [lng, lat] = c as number[];
      // GeoJSON: [lng, lat]. Если так не сходится, а наоборот сходится —
      // порядок осей перепутан. Считаем и называем, но не переставляем.
      if (inLng(lng) && inLat(lat)) continue;
      bad += 1;
      if (inLng(lat) && inLat(lng)) swapped += 1;
    }
    if (bad > 0) {
      shapes.out_of_range += 1;
      // Однозначность: перестановкой объясняются ВСЕ негодные точки, а не
      // часть. Смесь мусора и перестановки — разбор человека.
      const allExplained = swapped === bad;
      if (allExplained) shapes.suspect_swapped += 1;
      if (shapes.samples.length < 12) {
        shapes.samples.push({
          id: row.id, title: row.title ?? '(без названия)', type,
          note: allExplained
            ? `${bad} точек вне диапазона, и все сходятся при обратном порядке осей`
            : swapped > 0
              ? `${bad} точек вне диапазона, перестановкой объясняются лишь ${swapped} — разбирать человеку`
              : `${bad} точек вне диапазона широты/долготы`,
        });
      }
    }
  }

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
    const scatteredWps = pointsAreCollection(wps);
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
    const scatteredGeo = routeIntegrity(track, wps).verdict === 'not_a_path';
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
    shapes,
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
