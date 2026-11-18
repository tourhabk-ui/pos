/**
 * Маршруты места — одно правило на карточку и на Кузьмича (03.10).
 *
 * Повод — снимок владельца: на «дай мне маршрут к горе» Кузьмич ответил «он
 * не оцифрован на платформе», а у карточки «Горы Замок» маршрут есть. Ни один
 * инструмент Кузьмича связи «место → маршрут» не видел вовсе, и честный по
 * виду ответ был ответом про пробел в инструменте, а не про платформу.
 *
 * Отбор взят из карточки места (lib/places/place-detail), а не написан
 * заново: фильтр живости уже однажды отсутствовал в копии — турист видел
 * ссылку на «маршрут» в 397 км, которого в каталоге не было. Две копии
 * одного фильтра расходятся, поэтому копия одна.
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { lineOwnership } from '@/lib/routes/line-ownership';

/**
 * $1 — places.id места. id маршрута — в пространстве VIEW
 * (COALESCE(ark_id, id)), slug — для ссылки: голый kr.id у маршрута с
 * заполненным ark_id карточка /routes/[id] не находит.
 */
export const PLACE_ROUTES_SQL = `
  SELECT COALESCE(kr.ark_id, kr.id) AS id, kr.slug, kr.title, kr.activity_type, kr.difficulty,
         kr.distance_km, kr.duration_hours, rw.link_kind,
         -- Факты §10 — для Кузьмича (lib/kuzmich/guardian-context, 14.10):
         -- без них он знал о маршрутах места только название и длину.
         kr.elevation_gain_m, kr.season, kr.hazards, kr.equipment,
         kr.mchs_registration_required, kr.mchs_phone, kr.park_name,
         -- Точка записи и вершины линии — только для судьи подъезда
         -- (lineWithApproach ниже); наружу их не отдаёт ни карточка, ни
         -- Кузьмич.
         kr.lat AS route_lat, kr.lng AS route_lng,
         kr.geometry->'coordinates' AS line_coords
    FROM route_waypoints rw
    JOIN kamchatka_routes kr ON kr.id = rw.route_id
   WHERE rw.place_id = $1
     AND kr.is_visible = TRUE
     AND kr.merged_into_id IS NULL
     -- Двойник места (маршрут с тем же slug, что у видимого места)
     -- отвечает 308 на карточку места — ссылка на него вела бы по кругу
     -- (решение владельца 29.09, аудит SEO).
     AND NOT EXISTS (SELECT 1 FROM places tp WHERE tp.slug = kr.slug AND tp.is_visible = TRUE)
   ORDER BY (kr.geometry IS NOT NULL) DESC, (kr.distance_km IS NOT NULL) DESC, kr.title
   LIMIT 10`;

export interface PlaceRouteRow {
  id: string;
  slug: string | null;
  title: string;
  activity_type?: string | null;
  difficulty?: string | null;
  distance_km?: string | number | null;
  duration_hours?: string | number | null;
  /** Род связи (миграция 874): waypoint / nearby / unknown. */
  link_kind?: string | null;
  elevation_gain_m?: number | null;
  season?: string | null;
  hazards?: string[] | null;
  equipment?: string[] | null;
  mchs_registration_required?: boolean | null;
  mchs_phone?: string | null;
  park_name?: string | null;
  /**
   * Длина линии, в которую влит подъезд (#3487): число из distance_km, когда
   * судья принадлежности сказал own_with_approach. Тогда distance_km — null:
   * длиной тропы это число не является. Заполняет placeRoutesFor.
   */
  distance_with_approach_km?: number | null;
}

/** Сырые поля строки, нужные только судье подъезда. */
export interface PlaceRouteLineFields {
  route_lat?: string | number | null;
  route_lng?: string | number | null;
  line_coords?: unknown;
}

/**
 * Влит ли в линию маршрута подъезд (#3487, маршрут «Ксудач и Ходутка»:
 * 242,5 км с дорогой, дальний конец в 112 км от места).
 *
 * Тот же судья и те же входы, что у подписи на карточке маршрута
 * (lib/routes/line-ownership, app/routes/[id]): точка записи маршрута и
 * вершины линии. Длина такой линии — не длина тропы, и карточка места не
 * должна называть её так. Судить нечем (нет точки, нет линии) — false:
 * подписи нет, как и на карточке маршрута.
 */
export function lineWithApproach(row: PlaceRouteLineFields): boolean {
  const lat = row.route_lat == null ? NaN : Number(row.route_lat);
  const lng = row.route_lng == null ? NaN : Number(row.route_lng);
  const coords = Array.isArray(row.line_coords) ? (row.line_coords as number[][]) : null;
  if (!coords) return false;
  return lineOwnership({
    routePoint: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    coords,
  }).verdict === 'own_with_approach';
}

/**
 * Строка базы → строка маршрута места: без сырых полей линии, а длина линии с
 * подъездом — отдельным полем, не длиной маршрута.
 */
export function toPlaceRouteRow(raw: PlaceRouteRow & PlaceRouteLineFields): PlaceRouteRow {
  const row: PlaceRouteRow & PlaceRouteLineFields = { ...raw };
  delete row.route_lat;
  delete row.route_lng;
  delete row.line_coords;
  const km = row.distance_km != null && Number.isFinite(Number(row.distance_km)) ? Number(row.distance_km) : null;
  if (km !== null && lineWithApproach(raw)) {
    return { ...row, distance_km: null, distance_with_approach_km: km };
  }
  return { ...row, distance_with_approach_km: null };
}

/** Адрес карточки маршрута — тот же, что у ссылки на карточке места. */
export function routePageUrl(r: Pick<PlaceRouteRow, 'id' | 'slug'>): string {
  return `${getPublicBaseUrl()}/routes/${r.slug ?? r.id}`;
}

/**
 * Строки для ответа Кузьмича. «Рядом» (link_kind = nearby) — это «загляните
 * по пути», а не «маршрут проходит здесь» (§4.1): называется отдельно, чтобы
 * модель не повела туриста к месту маршрутом, который через него не идёт.
 */
export function placeRoutesLines(routes: PlaceRouteRow[]): string[] {
  const through = routes.filter((r) => r.link_kind !== 'nearby');
  const nearby = routes.filter((r) => r.link_kind === 'nearby');
  // Длина — словом «длина маршрута», не голым «N км» (03.10). Кузьмич на
  // Батарее Максутова сказал «рядом, в полутора километрах, маршрут „Скалы
  // Три Брата“»: «, 1.5 км» стояло после имени маршрута в строке «Рядом
  // проходят», и модель прочла ДЛИНУ маршрута как РАССТОЯНИЕ до него.
  const fmt = (r: PlaceRouteRow) => {
    // Длина линии с подъездом — не длина маршрута (#3487): сказано прямо,
    // иначе 242,5 км дороги звучали бы как тропа к вулкану.
    const km = r.distance_with_approach_km != null
      ? `, длина линии ${r.distance_with_approach_km} км вместе с подъездом — это не длина тропы`
      : r.distance_km != null && Number.isFinite(Number(r.distance_km)) ? `, длина маршрута ${Number(r.distance_km)} км` : '';
    return `«${r.title}»${km} — ${routePageUrl(r)}`;
  };
  const lines: string[] = [];
  if (through.length) lines.push(`Маршруты через это место на сайте: ${through.map(fmt).join('; ')}`);
  // Связь «рядом» — миграция 167, «в 15 км от центра маршрута» (§4.1):
  // сколько от места до маршрута, она не знает. Сказано прямо, чтобы число
  // не досочинялось.
  if (nearby.length) lines.push(`Рядом проходят (через само место не идут; расстояние от места до них не измерено): ${nearby.map(fmt).join('; ')}`);
  return lines;
}

/**
 * Маршруты места. Отказ базы не выдаётся за «маршрутов нет» (§4.0): null —
 * «не смог проверить», и вызывающий говорит это словами.
 */
export async function placeRoutesFor(placeId: string): Promise<PlaceRouteRow[] | null> {
  try {
    const { rows } = await pool.query<PlaceRouteRow>(PLACE_ROUTES_SQL, [placeId]);
    // Строки несут и сырые поля линии (PlaceRouteLineFields) — судье подъезда.
    return rows.map((r) => toPlaceRouteRow(r as PlaceRouteRow & PlaceRouteLineFields));
  } catch (err) {
    console.error('[place-routes] маршруты места не прочитаны:', placeId, err instanceof Error ? err.message : err);
    return null;
  }
}
