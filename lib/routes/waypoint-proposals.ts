/**
 * lib/routes/waypoint-proposals.ts
 *
 * Кого из мест линия маршрута действительно проходит.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Перепись 17.08: из 411 маршрутов у 154 есть линия и НИ ОДНОЙ путевой точки.
 * Это больше половины всех линий. Сверить такую линию не с чем, показать
 * этапы нечем, а проверка «точки расходятся с линией» на них молчит — не
 * потому, что всё хорошо, а потому, что мерить нечем.
 *
 * У этих маршрутов есть то, чего нет у остальных: сама линия. Значит точки
 * не надо угадывать по названию — их можно НАЙТИ. Место, лежащее в полусотне
 * метров от линии, эта линия проходит; место в трёх километрах — нет, даже
 * если названия похожи.
 *
 * ── Почему не как в миграции 167 ────────────────────────────────────────────
 *
 * Миграция 167 привязывала места по близости к ЯКОРЮ маршрута в радиусе 15 км
 * и записывала до пятнадцати штук. Якорь — одна точка, обычно посёлок старта;
 * на Камчатке из одного посёлка уходят пути в разные стороны. Радиус в
 * пятнадцать километров вокруг Эссо накрывает и сопку, и источники, и всё
 * между ними. Такое правило уже дало привязку трека «Вулкан Ичинская сопка» к
 * «Эссовским термальным источникам» (см. track-attachment-audit).
 *
 * Здесь мера другая: расстояние до САМОЙ ЛИНИИ и порядок ВДОЛЬ неё. Это не
 * догадка о том, куда ведёт путь, а измерение того, где он проходит.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 *
 * Модуль ничего не пишет. Сначала измерение: сколько маршрутов вообще можно
 * привязать и насколько уверенно. Писать в route_waypoints по непроверенному
 * правилу значит добавить к 154 пустым маршрутам N неверно размеченных, а
 * неверная точка на маршруте хуже отсутствующей: по ней пойдут.
 */

import { pool } from '@/lib/db-pool';
import { projectOnTrack, type GeoPoint } from '@/lib/on-route/approach';
import { geometryToTrack } from '@/lib/routes/geometry-audit';

/**
 * Ближе этого места считаются лежащими НА линии.
 *
 * Двести метров — ширина, на которой место и тропа неразличимы для идущего:
 * он видит и то, и другое. Порог намеренно жёсткий и не равен ни одному из
 * порогов привязки ТРЕКОВ к маршрутам (там 4 км, и там решается другой
 * вопрос — какому маршруту принадлежит трек целиком).
 *
 * Ошибка здесь дорога несимметрично: пропущенная точка оставляет маршрут
 * таким же, каким он был, а лишняя ставит на пути место, которого на нём нет,
 * и человек пойдёт его искать.
 */
export const ON_LINE_KM = 0.2;

/**
 * Дальше этого место к линии не относится даже как «рядом».
 *
 * Промежуток между двумя порогами — это «около линии»: не точка маршрута, но
 * и не случайное совпадение. Такие показываются отдельно, потому что среди
 * них живут настоящие точки маршрутов с грубой геометрией, и решать по ним
 * должен человек.
 */
export const NEAR_LINE_KM = 1;

/** Меньше этого числа точек — привязывать нечего: путь не описан. */
export const MIN_WAYPOINTS = 2;

export interface ProposedWaypoint {
  placeId: string;
  name: string;
  /** Расстояние от места до линии, км. */
  offLineKm: number;
  /** Порядковый номер вдоль линии, 0 — ближе к началу. */
  position: number;
}

export interface RouteProposal {
  routeId: string;
  title: string;
  trackPoints: number;
  /** Места на линии — предложение в route_waypoints. */
  onLine: ProposedWaypoint[];
  /** Места около линии — на решение человека, не для записи. */
  nearLine: ProposedWaypoint[];
}

export interface WaypointProposalReport {
  /** Маршрутов с линией и без единой путевой точки. */
  candidates: number;
  /** Из них можно разметить: на линии нашлось MIN_WAYPOINTS и больше. */
  anchorable: number;
  /** Нашлось одно место — путь так не опишешь. */
  single_place: number;
  /** На линии нет ни одного места. */
  empty: number;
  /** Сколько точек предложится всего, если записать. */
  proposed_waypoints: number;
  on_line_km: number;
  near_line_km: number;
  /** Образцы — по ним разбирают руками. */
  samples: RouteProposal[];
  /** Маршруты, где рядом есть места, но ни одно не легло на линию. */
  near_only_samples: RouteProposal[];
}

interface PlaceRow { id: string; name: string; lat: number; lng: number }
interface RouteRow { id: string; title: string | null; geometry: unknown }

/** Грубый габарит трека с запасом — чтобы не мерить все места до всех линий. */
function bbox(track: GeoPoint[], padKm: number) {
  let latMin = Infinity, latMax = -Infinity, lngMin = Infinity, lngMax = -Infinity;
  for (const p of track) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lng < lngMin) lngMin = p.lng;
    if (p.lng > lngMax) lngMax = p.lng;
  }
  const dLat = padKm / 111.32;
  // Долготный градус на Камчатке короче широтного примерно вдвое; берём с
  // запасом по самой северной широте набора — сузить рамку значит потерять
  // кандидата, расширить — только посчитать лишнее.
  const dLng = padKm / (111.32 * Math.cos((Math.max(Math.abs(latMin), Math.abs(latMax)) * Math.PI) / 180));
  return { latMin: latMin - dLat, latMax: latMax + dLat, lngMin: lngMin - dLng, lngMax: lngMax + dLng };
}

/**
 * Предложить путевые точки маршрутам, у которых есть линия и нет точек.
 *
 * Ничего не записывает. `limit` ограничивает разбор — на случай, когда
 * перепись зовут ради быстрой прикидки, а не полного счёта.
 */
export async function proposeWaypoints(limit?: number): Promise<WaypointProposalReport> {
  const placesRes = await pool.query<PlaceRow>(
    `SELECT id, name, lat::float8 AS lat, lng::float8 AS lng
       FROM places
      WHERE lat IS NOT NULL AND lng IS NOT NULL
        AND merged_into_id IS NULL`,
  );
  const places = placesRes.rows;

  const routesRes = await pool.query<RouteRow>(
    `SELECT kr.id, kr.title, kr.geometry
       FROM kamchatka_routes kr
      WHERE kr.geometry IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM route_waypoints rw WHERE rw.route_id = kr.id)
      ORDER BY kr.id
      ${limit && limit > 0 ? 'LIMIT $1' : ''}`,
    limit && limit > 0 ? [limit] : [],
  );

  const report: WaypointProposalReport = {
    candidates: 0, anchorable: 0, single_place: 0, empty: 0, proposed_waypoints: 0,
    on_line_km: ON_LINE_KM, near_line_km: NEAR_LINE_KM,
    samples: [], near_only_samples: [],
  };

  for (const row of routesRes.rows) {
    const track = geometryToTrack(row.geometry);
    // Линия короче двух точек — не путь; такие считает перепись геометрии,
    // здесь им нечего предлагать.
    if (track.length < 2) continue;
    report.candidates += 1;

    const box = bbox(track, NEAR_LINE_KM + 0.5);
    const onLine: ProposedWaypoint[] = [];
    const nearLine: ProposedWaypoint[] = [];

    for (const pl of places) {
      if (pl.lat < box.latMin || pl.lat > box.latMax || pl.lng < box.lngMin || pl.lng > box.lngMax) continue;
      const proj = projectOnTrack({ lat: pl.lat, lng: pl.lng }, track);
      if (!proj) continue;
      const entry = {
        placeId: pl.id, name: pl.name,
        offLineKm: Math.round(proj.offTrackKm * 1000) / 1000,
        // Порядок вдоль линии: номер звена плюс доля внутри него. Сортировать
        // по расстоянию от начала было бы неверно на маршруте, который
        // возвращается той же тропой.
        position: proj.segment + proj.t,
      };
      if (proj.offTrackKm <= ON_LINE_KM) onLine.push(entry);
      else if (proj.offTrackKm <= NEAR_LINE_KM) nearLine.push(entry);
    }

    onLine.sort((a, b) => a.position - b.position);
    nearLine.sort((a, b) => a.position - b.position);
    onLine.forEach((w, i) => { w.position = i; });
    nearLine.forEach((w, i) => { w.position = i; });

    const proposal: RouteProposal = {
      routeId: row.id,
      title: row.title ?? '(без названия)',
      trackPoints: track.length,
      onLine,
      nearLine,
    };

    if (onLine.length >= MIN_WAYPOINTS) {
      report.anchorable += 1;
      report.proposed_waypoints += onLine.length;
      if (report.samples.length < 12) report.samples.push(proposal);
    } else if (onLine.length === 1) {
      report.single_place += 1;
    } else {
      report.empty += 1;
      // Отдельный образец: рядом места есть, а на линии ни одного. Это либо
      // грубая геометрия, либо линия не о том — и то, и другое разбирает
      // человек, а не порог.
      if (nearLine.length > 0 && report.near_only_samples.length < 8) {
        report.near_only_samples.push(proposal);
      }
    }
  }

  return report;
}
