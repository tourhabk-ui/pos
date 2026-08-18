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
import { isPlausibleTrackPoint } from '@/lib/routes/track';
import { trackFidelity } from '@/lib/routes/track-fidelity';
import { projectOnTrack, DATA_CONFLICT_KM } from '@/lib/on-route/approach';
import { routeNavigability, type NavigabilityVerdict } from '@/lib/routes/navigability';
import { buildRoutePassport } from '@/lib/routes/passport';
import { trackEvidence, type TrackEvidenceVerdict } from '@/lib/routes/track-evidence';
import { cleanTrack } from '@/lib/routes/track-clean';
import { findTitleDupes } from '@/lib/routes/title-dupes';
import { isCommercialRecord } from '@/lib/routes/commercial-titles';
import { boundingSpanKm } from '@/lib/routes/geometry-compact';
import { waypointFit, routeIntegrity, pointsAreCollection, type WaypointFitVerdict } from '@/lib/routes/shape-match';
import { isNamesakeOfRoute } from '@/lib/routes/broken-links';
import { isExtendedObject, type CoordSource } from '@/lib/places/coord-source';

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

/**
 * Расхождение точки с линией — ПОИМЁННО.
 *
 * Счётчик отказов говорит «20 маршрутов не сходятся с собственными точками» и
 * на этом умолкает. Двадцать — число, которое разбирают руками, но открыть
 * случай по счётчику нельзя: неизвестно, какой маршрут и какая точка. Здесь
 * названо всё, что нужно для решения одним взглядом: кто, с кем, на сколько,
 * откуда координата и что даст починка.
 */
export interface ConflictCase {
  routeId: string;
  routeTitle: string;
  placeId: string;
  placeTitle: string;
  /** Род места: у протяжённого расстояние слабый признак (сюда такие не попадают). */
  placeType: string | null;
  /** Откуда координата места: снята, угадана по названию, заглушка, не записано. */
  coordSource: CoordSource;
  offTrackKm: number;
  /**
   * Точка — тёзка маршрута. Тогда под подозрением ЛИНИЯ, а не привязка:
   * если трек «Восхождения на Вилючинский» не подходит к Вилючинскому ближе
   * восьми километров, к записи прицепили чужой трек.
   */
  namesake: boolean;
  /**
   * Расхождение — ЕДИНСТВЕННАЯ причина отказа.
   *
   * Главная цифра разбора: только у таких маршрутов починка даёт пригодность.
   * У остальных расхождение чинить тоже стоит, но черту они не пройдут всё
   * равно — и путать эти два результата нельзя.
   */
  onlyReason: boolean;
  waypoints: number;
  trackPoints: number;
  /**
   * ВСЕ точки маршрута с расстоянием до его же линии — чтобы смотреть, а не верить.
   *
   * Одна названная точка отвечает на вопрос «что не сошлось», но не на вопрос
   * «кто виноват». Список целиком отвечает сразу: если из восьми точек семь
   * лежат на линии, а восьмая — смотровая площадка в десяти километрах, дело
   * в привязке. Если же в стороне все, разъехались не точки, а линия — и
   * снимать привязки нельзя.
   *
   * Владелец 18.08 на предложение снять 16 привязок: «сначала смотрим».
   */
  points: Array<{
    title: string;
    type: string | null;
    /** Отход от линии, км. `null` — спроецировать не удалось. */
    offTrackKm: number | null;
    /** Протяжённый объект: у него координата это центроид, и расстояние слабый признак. */
    extended: boolean;
  }>;
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
  /**
   * Чем ЗАПИСАНО происхождение линии: kml_inbox, osm, idilesom,
   * waypoints_synthetic, «не указан».
   *
   * Проба 54 закрыла вопрос про обёртки — их нет. Зато она показала другое:
   * из 301 линии 277 считаются «снятым треком», и основание для этого одно —
   * эвристика плотности точек (`track-fidelity`). А на карте снятый трек
   * рисуется сплошной зелёной линией, и человек читает её как «здесь идут».
   *
   * По §12 вид линии обязан соответствовать происхождению. Происхождение
   * записано в самой геометрии (`geometry.source`), и спрашивать надо его, а
   * не угадывать по числу точек. Прежде чем менять рисование — сосчитать,
   * что в этом поле есть на самом деле: правило, опёртое на пустое поле,
   * будет хуже эвристики, а не лучше.
   */
  by_source: Record<string, number>;
  /**
   * Расхождение: линия из СИНТЕТИЧЕСКОГО источника, а эвристика зовёт её
   * снятым треком.
   *
   * Это и есть цена угадывания — набросок, нарисованный как путь.
   */
  synthetic_called_surveyed: number;
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
   * Координаты существуют на Земле, но не на Камчатке.
   *
   * Считается ОТДЕЛЬНО от `out_of_range`, потому что это разные поломки.
   * Точка `lat 53, lng 0` вполне валидна — она в Гвинейском заливе; проверка
   * диапазонов её пропускает, а на карте навигации она даёт сплошную зелёную
   * горизонталь через весь экран (полевые скрины 16–17.08: «Авачинский»,
   * «Козельский»). Причина — импортёр принимал за трек профиль высот
   * (`[[0, 795], ...]`) и разворачивал его как координаты.
   *
   * Аудит обязан такое ВИДЕТЬ, а не молча считать нормальной геометрией:
   * инструмент, которым меряют здоровье маршрутов, не может быть слеп к
   * дефекту, найденному в поле.
   *
   * Границы — из `isPlausibleTrackPoint` (lib/routes/track), те же, что у
   * карты и импортёра. Свой порог здесь разошёлся бы с ними.
   */
  outside_kamchatka: number;
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
   * Черта: сколько маршрутов платформа имеет право предлагать как путь.
   * Считается тем же правилом, что решает это на экране (lib/routes/navigability).
   */
  navigability: Record<NavigabilityVerdict, number>;
  /**
   * Почему маршруты не проходят черту — поимённо, со счётчиком.
   *
   * Без этого «пригодны: 0» не отвечает на главный вопрос: чинить данные,
   * порог или само правило.
   */
  navigability_reasons: Record<string, number>;
  /**
   * Улики записи: сколько импортированных линий можно ДОКАЗАТЬ как снятые.
   *
   * 17.08 скрейп понижен из «снятого трека» — доказательств не было. Владелец
   * в тот же вечер сообщил, что сайт-источник заявляет треки как полученные
   * от людей, которые их прошли. Заявление о чужой странице не говорит о
   * нашей копии (наш разбор уже писал в базу профиль высот вместо трека), но
   * делает 259 линий кандидатами. Это счёт кандидатов.
   */
  track_evidence: Record<TrackEvidenceVerdict, number>;
  /** Из них у скольких улики есть, но не полные — что именно мешает. */
  track_evidence_reasons: Record<string, number>;
  /**
   * Что даст отделение мусора.
   *
   * Владелец 17.08: «если треки реальные, но они замусорены». Мусор попал из
   * НАШЕГО разбора (регулярка ловила профиль высот), и правка 86316be закрыла
   * только границу новых записей. Здесь считается, скольким линиям отделение
   * постороннего вернёт улики записи — то есть цена работы и её приз.
   *
   * READ-ONLY: перепись ничего не чистит, только меряет.
   */
  cleanable: {
    /** Линий, где нашлось постороннее и остаток остаётся связным путём. */
    cleaned: number;
    /** Постороннего столько, что это не мусор, а другая запись. */
    not_cleanable: number;
    /** Из очищенных — сколько получают улики записи ПОСЛЕ отделения. */
    recorded_after_clean: number;
    /** Сколько точек отделяется всего. */
    points_removed: number;
    /** По какой причине отделено. */
    by_reason: Record<string, number>;
  };
  /**
   * Записи-близнецы: имена различаются только незначащим (тире, регистр, ё).
   *
   * Сухой прогон импорта OSM 18.08 нашёл в одной партии из восьми «Вулкан
   * Дыгерен-Оленгендэ» и «Вулкан Дыгерен–Оленгендэ» — одну сопку двумя
   * записями. Twins сравнивал маршрут с МЕСТОМ; друг с другом маршруты не
   * сравнивал никто, и число «411 маршрутов» врёт на величину дублей.
   */
  /**
   * Записи, чьё имя продаёт, а не ведёт: «Джип-тур», «Вертолётная экскурсия».
   *
   * Владелец 18.08: «есть по названиям коммерция, а не маршрут». Признак
   * составной — коммерческое слово И отсутствие пути; запись с настоящим
   * треком остаётся маршрутом, как бы её ни назвали.
   */
  commercial_records: {
    total: number;
    by_marker: Record<string, number>;
    samples: Array<{ id: string; title: string; marker: string }>;
  };
  title_dupes: {
    groups: number;
    /** Сколько записей лишние: сумма (размер группы − 1). */
    extra_records: number;
    /** Крупнейшие группы — с них начинать разбор. */
    samples: Array<{ key: string; titles: string[] }>;
  };
  /**
   * Сколько коммерции держится на проверенном. Нужно перед решением о снятии
   * маршрутов с витрины: если туры висят на непроверенных маршрутах, снятие
   * бьёт по продаже.
   */
  tours: {
    total: number;
    on_navigable_route: number;
    on_failing_route: number;
    without_route: number;
  };
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
  /**
   * Расхождения, из-за которых маршрут не проходит черту, — поимённо.
   *
   * Считается ТЕМ ЖЕ правилом, что выносит вердикт (`routeNavigability`
   * возвращает номер спорной точки), а не своим проходом по точкам: второй
   * проход дал бы второй ответ на один вопрос. Отличается от `worst` этим же:
   * `worst` меряет все точки подряд, черта пропускает протяжённые объекты.
   */
  conflict_cases: ConflictCase[];
  /** Из них тех, у кого расхождение — единственная причина отказа. */
  conflicts_only_reason: number;
  duration_ms: number;
}

interface RouteRow { id: string; title: string | null; geometry: unknown }

/** Путевая точка так, как её видит перепись: координата и всё, чем её можно назвать. */
interface AuditWaypoint {
  lat: number;
  lng: number;
  type: string | null;
  id: string;
  title: string;
  coordSource: CoordSource;
}

/**
 * Значение колонки → тип. Незнакомое и пустое честно становится `unknown`:
 * колонка заведена 18.08 (миграция 873), и у большинства строк она именно
 * такая.
 */
function asCoordSource(raw: string | null): CoordSource {
  switch (raw) {
    case 'surveyed':
    case 'geocoded':
    case 'placeholder':
      return raw;
    default:
      return 'unknown';
  }
}
interface WpRow {
  route_id: string;
  place_id: string;
  title: string | null;
  lat: string | null;
  lng: string | null;
  location_type: string | null;
  coord_source: string | null;
}

/**
 * Причина отказа → ключ счётчика.
 *
 * Причины пишутся ЧЕЛОВЕКУ и про КОНКРЕТНЫЙ маршрут: «Точка стоит в 14.2 км от
 * линии». Считать их как есть — получить по строке на маршрут вместо счётчика:
 * двадцать пять расхождений выглядели бы двадцатью пятью разными бедами.
 *
 * Числа поэтому заменяются на N. Это единственное, чем перепись трогает текст
 * причины: формулировки живут в navigability, здесь их не переписывают — иначе
 * перепись начнёт объяснять отказ своими словами, а слова разойдутся.
 */
export function reasonKey(reason: string): string {
  return reason.replace(/\d+([.,]\d+)?/g, 'N');
}

/** GeoJSON LineString → точки. Формат тот же, что читает offline-bundle. */
export function geometryToTrack(geometry: unknown): Array<{ lat: number; lng: number }> {
  const geo = geometry as { coordinates?: unknown } | null;
  if (!Array.isArray(geo?.coordinates)) return [];
  const out: Array<{ lat: number; lng: number }> = [];
  for (const c of geo.coordinates as unknown[]) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    /**
     * Точка вне края в трек не попадает — иначе она искажает ВСЁ, что
     * считается ниже: длину линии, расстояние точек до неё, вердикт
     * «набросок или снятый трек», габарит подборки. Одна координата в
     * Гвинейском заливе превращает нормальный маршрут в «подборку мест по
     * всему краю» и портит статистику, ради которой аудит и запускают.
     *
     * Сам факт такой точки при этом НЕ теряется: он считается выше, в
     * `shapes.outside_kamchatka`, с образцом. Фильтровать молча было бы той
     * же ошибкой, что и глухой catch — дефект превратился бы в тишину.
     */
    if (isPlausibleTrackPoint(lat, lng)) out.push({ lat, lng });
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
    by_type: {}, by_source: {}, synthetic_called_surveyed: 0,
    unsupported: 0, empty_or_single: 0,
    out_of_range: 0, outside_kamchatka: 0, suspect_swapped: 0, samples: [],
  };
  /** Источники, которые по своей природе НЕ являются снятым путём. */
  const SYNTHETIC = new Set(['waypoints_synthetic', 'synthetic']);
  const inLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
  const inLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;

  for (const row of listRes.rows) {
    const g = row.geometry as { type?: string; coordinates?: unknown; source?: string } | null;
    const type = g?.type ?? '(нет геометрии)';
    shapes.by_type[type] = (shapes.by_type[type] ?? 0) + 1;

    if (g) {
      // «(не указан)», а не пустая строка: отсутствие записи о происхождении
      // — тоже сведение, и именно оно решает, можно ли вообще опереться на
      // источник вместо эвристики.
      const src = g.source ?? '(не указан)';
      shapes.by_source[src] = (shapes.by_source[src] ?? 0) + 1;
    }

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

    let bad = 0, swapped = 0, offRegion = 0;
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const [lng, lat] = c as number[];
      // GeoJSON: [lng, lat]. Если так не сходится, а наоборот сходится —
      // порядок осей перепутан. Считаем и называем, но не переставляем.
      if (inLng(lng) && inLat(lat)) {
        // Координата существует, но не на Камчатке — отдельная поломка,
        // невидимая для проверки диапазонов. Именно она рисует горизонталь
        // через весь экран.
        if (!isPlausibleTrackPoint(lat, lng)) offRegion += 1;
        continue;
      }
      bad += 1;
      if (inLng(lat) && inLat(lng)) swapped += 1;
    }

    if (offRegion > 0) {
      shapes.outside_kamchatka += 1;
      if (shapes.samples.length < 12) {
        shapes.samples.push({
          id: row.id, title: row.title ?? '(без названия)', type,
          note: `${offRegion} точек вне Камчатки при валидных широте/долготе `
            + '— линия уйдёт через весь экран',
        });
      }
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
  //
  // Набор и порядок — ТЕ ЖЕ, что отдаёт карточка маршрута. Иначе перепись
  // меряет не то, чем платформа пользуется, и её цифры не про продукт.
  //
  // Скрытые и слитые точки исключены (`is_visible`, `merged_into_id`), потому
  // что их исключает карточка. Оставленные здесь, они судят маршрут по тому,
  // чего человек не увидит: слитый дубль в стороне от линии даёт расхождение
  // выше порога — и маршрут теряет обещание ведения из-за точки, которой на
  // экране нет. Смоук 17.08 нашёл это спором двух измерений: по API пригоден
  // один маршрут из пяти, по переписи — ноль из трёхсот.
  //
  // ORDER BY здесь не украшение. Порядок точек — измеряемая величина
  // (`waypointFit` считает инверсии), и без сортировки Postgres вправе вернуть
  // строки как угодно: счёт инверсий стал бы шумом. Раньше комментарий ниже
  // утверждал, что точки приходят упорядоченными, а запрос этого не просил.
  const wpRes = await pool.query<WpRow>(
    `SELECT rw.route_id::text, p.id::text AS place_id, p.name AS title,
            p.lat::text, p.lng::text, p.location_type, p.coord_source
       FROM route_waypoints rw
       JOIN places p ON p.id = rw.place_id
      WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND p.is_visible = TRUE
        AND p.merged_into_id IS NULL
      ORDER BY rw.route_id, rw.position`,
  );
  const byRoute = new Map<string, AuditWaypoint[]>();
  for (const w of wpRes.rows) {
    const lat = Number(w.lat), lng = Number(w.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const arr = byRoute.get(w.route_id) ?? [];
    arr.push({
      lat, lng,
      type: w.location_type,
      id: w.place_id,
      title: w.title ?? '(без названия)',
      coordSource: asCoordSource(w.coord_source),
    });
    byRoute.set(w.route_id, arr);
  }

  let no_geometry = 0, no_waypoints = 0, sketch_geometry = 0, surveyed_geometry = 0;
  let conflicting = 0, consistent = 0;
  let collections = 0, collections_by_waypoints = 0, collections_by_geometry = 0;
  /**
   * Черта (lib/routes/navigability): сколько маршрутов платформа имеет право
   * предлагать как путь. Считается ТЕМ ЖЕ правилом, что решает это на экране —
   * своего счёта здесь не заводим, иначе перепись и продукт разошлись бы в
   * ответе на один вопрос.
   */
  const verdicts: Record<NavigabilityVerdict, number> = {
    navigable: 0, orientation_only: 0, not_a_route: 0,
  };
  /** id пригодных — по ним считается, сколько туров держится на проверенном. */
  const navigableIds: string[] = [];
  /** Причины отказа поимённо: «ноль пригодных» без них ничего не объясняет. */
  const navReasons: Record<string, number> = {};
  /** Улики записи — считаются по СЫРОЙ геометрии: высота живёт третьим числом. */
  const evidence: Record<TrackEvidenceVerdict, number> = { recorded: 0, drawn: 0, unclear: 0 };
  const evidenceReasons: Record<string, number> = {};
  const commercial = {
    total: 0,
    by_marker: {} as Record<string, number>,
    samples: [] as Array<{ id: string; title: string; marker: string }>,
  };
  const cleanable = {
    cleaned: 0, not_cleanable: 0, recorded_after_clean: 0,
    points_removed: 0, by_reason: {} as Record<string, number>,
  };
  const by_shape: Record<WaypointFitVerdict, number> = {
    fits: 0, out_of_order: 0, off_track: 0, unknown: 0,
  };
  const flaws: RouteFlaw[] = [];
  /** Расхождения черты поимённо: 20 случаев разбирают руками, не счётчиком. */
  const conflictCases: ConflictCase[] = [];
  const collectionFlaws: CollectionFlaw[] = [];
  const orderCases: Array<{ id: string; title: string; inversions: number; waypoints: number; coverage: number | null }> = [];

  // Близнецы считаются по ВСЕМУ списку разом, а не в цикле: это свойство
  // набора, а не отдельной записи.
  const dupeGroups = findTitleDupes(listRes.rows.map((r) => ({ id: r.id, title: r.title })));

  await mapLimit(listRes.rows, CONCURRENCY, async (r) => {
    const track = geometryToTrack(r.geometry);
    if (track.length < 2) { no_geometry += 1; return; }

    // trackFidelity считает по парам [широта, долгота] — тому же виду, что
    // приходит с экрана; форму приводим здесь, правило не дублируем.
    const pairs = track.map((p) => [p.lat, p.lng] as [number, number]);
    const fidelity = trackFidelity(pairs);
    if (fidelity === 'sketch') sketch_geometry += 1;
    else surveyed_geometry += 1;

    // Цена угадывания: линия из СИНТЕТИЧЕСКОГО источника, которую эвристика
    // зовёт снятым треком. На карте такая рисуется сплошной зелёной — то
    // есть набросок предъявляется человеку как путь, по которому идут.
    const src = (r.geometry as { source?: string } | null)?.source;
    if (fidelity !== 'sketch' && src && SYNTHETIC.has(src)) {
      shapes.synthetic_called_surveyed += 1;
      if (shapes.samples.length < 12) {
        shapes.samples.push({
          id: r.id, title: r.title ?? '(без названия)', type: 'LineString',
          note: `источник «${src}» — синтетика, а плотность точек выдаёт её за снятый трек`,
        });
      }
    }

    const wps = byRoute.get(r.id) ?? [];
    const wpPairs = wps.map((w) => [w.lat, w.lng] as [number, number]);

    // Вердикт черты считается ДО всех ранних выходов ниже: подборка и маршрут
    // без точек тоже получают ответ, иначе сумма вердиктов не сошлась бы с
    // числом маршрутов и молчание читалось бы как «пригоден».
    const grade = buildRoutePassport({
      track: pairs.length >= 2 ? pairs : null,
      geometrySource: src ?? null,
      waypointsCount: wps.length,
      routeVersion: null, verifiedAt: null, updatedAt: null,
      mchsRequired: false, mchsPhone: null, parkName: null,
      parkApprovalUrl: null, officialPassportUrl: null,
    }).grade;
    // Коммерческое имя при пустом пути. Считается ЗДЕСЬ, где уже известны и
    // линия, и точки: по одному имени решать нельзя.
    const commercialHit = isCommercialRecord(r.title, {
      trackPoints: pairs.length,
      waypoints: wps.length,
    });
    if (commercialHit) {
      commercial.total += 1;
      commercial.by_marker[commercialHit.marker] = (commercial.by_marker[commercialHit.marker] ?? 0) + 1;
      if (commercial.samples.length < 15) {
        commercial.samples.push({ id: r.id, title: r.title ?? '(без названия)', marker: commercialHit.marker });
      }
    }

    // Улика считается ДО вердикта: черта спрашивает её, а не наоборот.
    const evidenceVerdict = trackEvidence(r.geometry).verdict;
    const nav = routeNavigability({
      grade,
      track: pairs.length >= 2 ? pairs : null,
      waypoints: wps,
      // Рода точек: у протяжённого объекта центроид далеко от тропы по
      // определению, и противоречием это не является.
      waypointTypes: wps.map((w) => w.type),
      evidence: evidenceVerdict,
    });
    verdicts[nav.verdict] += 1;
    if (nav.verdict === 'navigable') navigableIds.push(r.id);
    // Спорная точка называется поимённо. Номер приходит от самой черты —
    // считать расстояние здесь заново значило бы завести второе правило и
    // получить случаи, которых вердикт не видит (или не увидеть тех, что он
    // засчитал).
    if (nav.conflict) {
      const w = wps[nav.conflict.index];
      if (w) {
        conflictCases.push({
          routeId: r.id,
          routeTitle: r.title ?? '(без названия)',
          placeId: w.id,
          placeTitle: w.title,
          placeType: w.type,
          coordSource: w.coordSource,
          offTrackKm: Math.round(nav.conflict.offTrackKm * 10) / 10,
          namesake: isNamesakeOfRoute(r.title ?? '', w.title),
          onlyReason: nav.reasons.length === 1,
          waypoints: wps.length,
          trackPoints: pairs.length,
          points: wps.map((w) => {
            const pr = pairs.length >= 2 ? projectOnTrack(w, track) : null;
            return {
              title: w.title,
              type: w.type,
              offTrackKm: pr ? Math.round(pr.offTrackKm * 10) / 10 : null,
              extended: isExtendedObject(w.type),
            };
          }),
        });
      }
    }
    // Причина отказа считается поимённо.
    //
    // Прогон 17.08 вернул «пригодны: 0» и не сказал, почему. Ноль без причины
    // — то же молчание, с которым мы боремся весь день: непонятно, чинить ли
    // данные, порог или само правило. Счётчик отвечает на это одним взглядом.
    //
    for (const why of nav.reasons) {
      const key = reasonKey(why);
      navReasons[key] = (navReasons[key] ?? 0) + 1;
    }

    // Улики записи считаются по СЫРОЙ геометрии, а не по разобранным парам:
    // высота лежит третьим числом, и geometryToTrack его отбрасывает.
    const ev = trackEvidence(r.geometry);
    evidence[ev.verdict] += 1;
    for (const why of ev.reasons) {
      const key = reasonKey(why);
      evidenceReasons[key] = (evidenceReasons[key] ?? 0) + 1;
    }

    // Что даст отделение мусора. Считается ТОЛЬКО там, где улик не хватило:
    // у линии с полными уликами чистить нечего, и гонять её через чистку
    // значило бы измерять работу, которой нет.
    if (ev.verdict !== 'recorded') {
      const raw = (r.geometry as { coordinates?: unknown } | null)?.coordinates;
      const cleaned = cleanTrack(Array.isArray(raw) ? (raw as number[][]) : []);
      if (cleaned.verdict === 'cleaned') {
        cleanable.cleaned += 1;
        cleanable.points_removed += cleaned.removed.length;
        for (const rm of cleaned.removed) {
          cleanable.by_reason[rm.reason] = (cleanable.by_reason[rm.reason] ?? 0) + 1;
        }
        // Главная цифра: вернула ли чистка линии улики записи. Без неё счёт
        // «очищено 40» не говорит, стало ли от этого хоть одним настоящим
        // треком больше.
        const after = trackEvidence({ type: 'LineString', coordinates: cleaned.points });
        if (after.verdict === 'recorded') cleanable.recorded_after_clean += 1;
      } else if (cleaned.verdict === 'not_cleanable' && cleaned.removed.length > 0) {
        cleanable.not_cleanable += 1;
      }
    }

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
    // не измерением, а шумом. Утверждение держится ORDER BY в запросе выше;
    // до 17.08 оно держалось только этим комментарием, а запрос сортировки не
    // просил — то есть счёт инверсий всё это время был шумом.
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

  /**
   * Сколько коммерции держится на проверенном.
   *
   * Вопрос владельца 17.08 перед решением о снятии маршрутов с витрины: если
   * туры ссылаются на маршруты, не прошедшие черту, то снятие бьёт по продаже,
   * и начинать надо с них. Считается по факту, а не на глаз.
   */
  const toursRes = await pool.query<{ total: string; on_navigable: string; without_route: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE route_id = ANY($1::uuid[]))::text AS on_navigable,
            COUNT(*) FILTER (WHERE route_id IS NULL)::text AS without_route
       FROM operator_tours`,
    [navigableIds],
  );
  const tTotal = parseInt(toursRes.rows[0]?.total ?? '0', 10);
  const tNav = parseInt(toursRes.rows[0]?.on_navigable ?? '0', 10);
  const tNone = parseInt(toursRes.rows[0]?.without_route ?? '0', 10);
  const tours = {
    total: tTotal,
    on_navigable_route: tNav,
    on_failing_route: tTotal - tNav - tNone,
    without_route: tNone,
  };

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
    // Не режется: этих случаев два десятка, и режут списки там, где их не
    // разбирают. Этот разбирают.
    conflict_cases: conflictCases,
    conflicts_only_reason: conflictCases.filter((c) => c.onlyReason).length,
    navigability: verdicts,
    navigability_reasons: navReasons,
    track_evidence: evidence,
    track_evidence_reasons: evidenceReasons,
    cleanable,
    commercial_records: commercial,
    title_dupes: {
      groups: dupeGroups.length,
      extra_records: dupeGroups.reduce((n, g) => n + g.members.length - 1, 0),
      samples: dupeGroups.slice(0, 12).map((g) => ({ key: g.key, titles: g.members.map((m) => m.title) })),
    },
    tours,
    duration_ms: Date.now() - startedAt,
  };
}
