/**
 * lib/services/safety/park-scope-census.ts — КАКИМ ПУТЁМ ЗАКРЫТИЕ ПАРКА ДОШЛО ДО МЕСТА.
 *
 * Слово владельца 22.11 («1 да»): сначала замер, потом правка правила.
 *
 * Повод — сверка 21.11 в #3487. На карточке Халактырского пляжа стоит
 * «Тропы парка закрыты на межсезонье», а пляж в природный парк не входит:
 * 8.11 места внутри контура «Налычево» сверяли с OpenStreetMap (миграции
 * 1248, 1407), и пляжа среди них нет. По коду закрытие доходит до него через
 * маршрут «Озеро Приливное – Халактырский пляж»: место — путевая точка
 * маршрута, у которого записана территория парка. Сколько таких мест на проде
 * и какие маршруты их тянут, из репозитория не видно — это факт о данных.
 *
 * Перепись отвечает:
 *  - сколько видимых мест правило закрытия считает «в парке» и каким путём
 *    (PARK_PATHS — те же пути, что у правила; своего текста здесь нет);
 *  - у каких мест в парк ведут ТОЛЬКО пути через маршрут (`ROUTE_ONLY_PATHS`):
 *    ни имя места, ни проверенный контур этого не подтверждают. Каждое — с
 *    маршрутами, через которые оно стало «в парке», и с цветом карточки
 *    сейчас;
 *  - по названным slug — разбор места или маршрута: пути по каждому парку,
 *    у маршрута записанная территория, случай разрешения и слова блока на
 *    карточке (то же правило, что route-permit-census).
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ДЕЛАЕТ. Не судит, лежит ли место в парке: контурные
 * списки неполны («место без связи не значит „не в парке“», 1407), и место
 * из списка «только через маршрут» может быть в парке на деле. Это список
 * для глаз, а не приговор. Ничего не пишет.
 *
 * ПД нет: имена мест и маршрутов, территории и цвет карточки — публичные
 * данные каталога.
 */
import { pool } from '@/lib/db-pool';
import { PARK_PATHS, PARK_MEMBERSHIP_SQL, type ParkPathKey } from '@/lib/services/safety/alert-place-scope';
import { routeInParkSql } from '@/lib/parks/route-in-park';
import { lookupFromRows, routePermitCase, type ParkPermitRow, type RoutePermitCase } from '@/lib/parks/route-permit';
import { permitCardCase, permitCardWording, webHref, type PermitCardWording } from '@/lib/parks/route-permit-card';
import { PARK_PERMIT_ROW_JSON_SQL, cardShowsPermitBlock } from '@/lib/parks/route-permit-census';

/** Пути, которые говорят о самом месте: его имя называет парк, точка внутри контура. */
export const OWN_PATHS: readonly ParkPathKey[] = ['own_name', 'contour'];
/** Пути, по которым место попадает в парк из-за маршрута. */
export const ROUTE_ONLY_PATHS: readonly ParkPathKey[] = ['route_through_place', 'place_in_route_title', 'route_title_in_place'];

/** Сколько строк списка назвать поимённо; остаток называется числом. */
export const ROUTE_ONLY_LIMIT = 150;
/** Сколько slug можно спросить за раз. */
export const LOOKUP_LIMIT = 20;

const PATH_KEYS = PARK_PATHS.map((p) => p.key);
const PATH_COLUMNS = PARK_PATHS.map((p) => `COALESCE((${p.sql}), false) AS ${p.key}`).join(',\n         ');

/**
 * Видимые места × парки, где правило закрытия считает место «в парке».
 * `ark` собран из `places` той же формы, что строка agent_route_knowledge у
 * правила: `id` — ark_id места, `title` — имя.
 */
export const PLACE_PARK_PATHS_SQL = `
  WITH ark AS (
    SELECT pl0.ark_id AS id, pl0.name AS title, pl0.slug, pl0.id::text AS place_id,
           pl0.lat::float8 AS lat, pl0.lng::float8 AS lng
      FROM places pl0
     WHERE pl0.ark_id IS NOT NULL
       AND pl0.is_visible = TRUE
       AND pl0.merged_into_id IS NULL
  )
  SELECT ark.place_id, ark.slug, ark.title, ark.lat, ark.lng,
         pk.slug AS park_slug, pk.display_name AS park_name,
         lrs.recommender_status AS status, lrs.status_reason,
         ${PATH_COLUMNS}
    FROM ark
    CROSS JOIN parks pk
    LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = ark.id
   WHERE (${PARK_MEMBERSHIP_SQL})
   ORDER BY ark.title, pk.slug`;

/**
 * Маршруты, через которые место попадает в парк путём `route_through_place`:
 * то же соединение, что у пути (путевая точка не «рядом», территория маршрута
 * называет парк). $1 — id мест.
 */
export const PLACE_PARK_ROUTES_SQL = `
  SELECT pl.id::text AS place_id, pk.slug AS park_slug,
         kr.title, kr.slug, kr.park_name, kr.is_visible,
         COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') AS link_kind
    FROM places pl
    JOIN route_waypoints rw ON rw.place_id = pl.id
    JOIN kamchatka_routes kr ON kr.id = rw.route_id
    JOIN parks pk ON ${routeInParkSql('kr.park_name', 'pk.search_term', 'pk.display_name')}
   WHERE pl.id::text = ANY($1::text[])
     AND COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'
   ORDER BY pl.id, pk.slug, kr.title`;

/** Видимые места по slug — чтобы «в парк не попадает» не путать с «места нет». $1 — slug. */
export const PLACES_BY_SLUG_SQL = `
  SELECT pl.slug FROM places pl
   WHERE pl.slug = ANY($1::text[]) AND pl.is_visible = TRUE AND pl.merged_into_id IS NULL`;

/**
 * Маршруты по slug, id или ark_id × парки, где правило считает маршрут «в
 * парке». LEFT JOIN: маршрут вне всех парков тоже возвращается строкой.
 * `query` — какой из спрошенных ключей нашёл строку.
 */
export const ROUTE_PARK_PATHS_SQL = `
  WITH q AS (SELECT unnest($1::text[]) AS query),
  ark AS (
    SELECT q.query, kr0.id::text AS route_id, COALESCE(kr0.ark_id, kr0.id) AS id, kr0.title, kr0.slug,
           kr0.park_name, kr0.mchs_registration_required, kr0.park_approval_url, kr0.is_visible,
           kr0.lat::float8 AS lat, kr0.lng::float8 AS lng
      FROM q
      JOIN kamchatka_routes kr0 ON q.query IN (kr0.slug, kr0.id::text, kr0.ark_id::text)
  )
  SELECT ark.query, ark.route_id, ark.title, ark.slug, ark.park_name, ark.mchs_registration_required, ark.park_approval_url,
         ark.is_visible, ark.lat, ark.lng,
         pk.slug AS park_slug,
         ${PARK_PATHS.map((p) => `COALESCE((${p.sql}), false) AS ${p.key}`).join(',\n         ')}
    FROM ark
    LEFT JOIN parks pk ON (${PARK_MEMBERSHIP_SQL})
   ORDER BY ark.query, ark.title, ark.route_id, pk.slug`;

/** Строки справочника по территориям маршрутов — тем же условием, что живой ответ. */
export const ROUTE_TERRITORY_PARKS_SQL = `
  SELECT n.park_name,
         json_agg(${PARK_PERMIT_ROW_JSON_SQL} ORDER BY p.slug) FILTER (WHERE p.slug IS NOT NULL) AS parks
    FROM unnest($1::text[]) AS n(park_name)
    LEFT JOIN parks p
      ON p.is_active
     AND ${routeInParkSql('n.park_name', 'p.search_term', 'p.display_name')}
   GROUP BY n.park_name`;

type PathFlags = Record<ParkPathKey, boolean>;

export interface PlaceParkRow extends PathFlags {
  place_id: string;
  slug: string | null;
  title: string;
  lat: number | null;
  lng: number | null;
  park_slug: string;
  park_name: string;
  status: string | null;
  status_reason: string | null;
}

export interface PlaceParkRouteRow {
  place_id: string;
  park_slug: string;
  title: string;
  slug: string | null;
  park_name: string | null;
  is_visible: boolean | null;
  link_kind: string;
}

export interface RouteParkRow extends Partial<PathFlags> {
  query: string;
  route_id: string;
  title: string;
  slug: string | null;
  park_name: string | null;
  mchs_registration_required: boolean | null;
  park_approval_url: string | null;
  is_visible: boolean | null;
  lat: number | null;
  lng: number | null;
  park_slug: string | null;
}

export interface RouteOnlyItem {
  place: string;
  slug: string | null;
  lat: number | null;
  lng: number | null;
  park: string;
  paths: ParkPathKey[];
  /** Цвет карточки сейчас и его причина (park_season — межсезонное закрытие). */
  status: string | null;
  status_reason: string | null;
  /** Маршруты пути `route_through_place`; у путей по имени маршрутов здесь нет. */
  routes: Array<{ title: string; slug: string | null; park_name: string | null; link_kind: string; visible: boolean | null }>;
}

export interface ParkScopeCensus {
  places: {
    /** Пар «место — парк», где правило закрытия считает место в парке. */
    pairs_total: number;
    /** Разных мест в каком-либо парке. */
    places_total: number;
    /** Сколько пар держит каждый путь (пара может держаться несколькими). */
    by_path: Record<ParkPathKey, number>;
    /** Пары, где в парк ведут только пути через маршрут. */
    route_only_total: number;
    /** Из них карточка сейчас не зелёная. */
    route_only_not_green: number;
    route_only: RouteOnlyItem[];
    /** Сколько строк списка не названо поимённо (предел ROUTE_ONLY_LIMIT). */
    route_only_not_listed: number;
    /** Пары «маршрут через место» без найденного маршрута — пути разошлись с выборкой маршрутов. */
    route_paths_without_routes: number;
  };
  lookup: {
    places: Array<{ slug: string; found: boolean; parks: Array<{ park: string; paths: ParkPathKey[]; status: string | null; status_reason: string | null; routes: RouteOnlyItem['routes'] }> }>;
    routes: Array<{
      query: string;
      found: boolean;
      /** Сколько разных маршрутов нашёл ключ (больше одного — назван первый по имени). */
      matches?: number;
      title?: string;
      slug?: string | null;
      park_name?: string | null;
      visible?: boolean | null;
      mchs_registration_required?: boolean | null;
      has_approval_url?: boolean;
      lat?: number | null;
      lng?: number | null;
      /** Парки, где правило закрытия считает маршрут, и каким путём. */
      parks?: Array<{ park: string; paths: ParkPathKey[] }>;
      /** Случай условий посещения в ответе агенту и слова блока на карточке. */
      permit_kind?: RoutePermitCase['kind'];
      card_block_shown?: boolean;
      card_wording?: PermitCardWording | null;
      /** Сколько строк справочника нашла записанная территория. */
      territory_parks?: string[];
    }>;
  };
  duration_ms: number;
}

function pathsOf(row: Partial<PathFlags>): ParkPathKey[] {
  return PATH_KEYS.filter((k) => row[k] === true);
}

/** Пара держится только путями через маршрут: имя места и контур молчат. */
export function isRouteOnly(paths: readonly ParkPathKey[]): boolean {
  return paths.length > 0
    && paths.every((p) => !OWN_PATHS.includes(p))
    && paths.some((p) => ROUTE_ONLY_PATHS.includes(p));
}

/** Счёт по прочитанным строкам — чистая функция, её судит сторож. */
export function countPlacePaths(
  rows: readonly PlaceParkRow[],
  routes: readonly PlaceParkRouteRow[],
): ParkScopeCensus['places'] {
  const byPath = Object.fromEntries(PATH_KEYS.map((k) => [k, 0])) as Record<ParkPathKey, number>;
  const routesBy = new Map<string, RouteOnlyItem['routes']>();
  for (const r of routes) {
    const key = `${r.place_id}|${r.park_slug}`;
    const list = routesBy.get(key) ?? [];
    list.push({ title: r.title, slug: r.slug, park_name: r.park_name, link_kind: r.link_kind, visible: r.is_visible });
    routesBy.set(key, list);
  }

  const places = new Set<string>();
  const routeOnly: RouteOnlyItem[] = [];
  let withoutRoutes = 0;
  for (const row of rows) {
    const paths = pathsOf(row);
    if (paths.length === 0) continue;
    places.add(row.place_id);
    for (const p of paths) byPath[p] += 1;
    if (!isRouteOnly(paths)) continue;
    const list = routesBy.get(`${row.place_id}|${row.park_slug}`) ?? [];
    if (paths.includes('route_through_place') && list.length === 0) withoutRoutes += 1;
    routeOnly.push({
      place: row.title, slug: row.slug, lat: row.lat, lng: row.lng, park: row.park_slug, paths,
      status: row.status, status_reason: row.status_reason, routes: list,
    });
  }

  // Сначала карточки, которые сейчас не зелёные: там турист видит плашку.
  routeOnly.sort((a, b) => Number(a.status === 'green') - Number(b.status === 'green')
    || a.place.localeCompare(b.place, 'ru') || a.park.localeCompare(b.park));

  return {
    pairs_total: rows.filter((r) => pathsOf(r).length > 0).length,
    places_total: places.size,
    by_path: byPath,
    route_only_total: routeOnly.length,
    route_only_not_green: routeOnly.filter((r) => r.status !== 'green').length,
    route_only: routeOnly.slice(0, ROUTE_ONLY_LIMIT),
    route_only_not_listed: Math.max(0, routeOnly.length - ROUTE_ONLY_LIMIT),
    route_paths_without_routes: withoutRoutes,
  };
}

/** Разбор маршрутов по slug: пути по паркам, случай разрешения, слова блока. */
export function describeRoutes(
  queries: readonly string[],
  rows: readonly RouteParkRow[],
  territories: ReadonlyArray<{ park_name: string; parks: ParkPermitRow[] | null }>,
): ParkScopeCensus['lookup']['routes'] {
  const parksByName = new Map(territories.map((t) => [t.park_name, t.parks ?? []]));
  const out: ParkScopeCensus['lookup']['routes'] = [];
  for (const q of queries) {
    const all = rows.filter((r) => r.query === q);
    if (all.length === 0) { out.push({ query: q, found: false }); continue; }
    const first = all[0] as RouteParkRow;
    const hit = all.filter((x) => x.route_id === first.route_id);
    const r = first;
    const parkName = r.park_name && r.park_name.trim() ? r.park_name : null;
    const territoryRows = parkName ? parksByName.get(parkName) ?? null : null;
    const permit = routePermitCase({ title: r.title, parkName }, territoryRows ? lookupFromRows(territoryRows) : null);
    const shown = cardShowsPermitBlock({
      title: r.title, park_name: parkName,
      mchs_registration_required: r.mchs_registration_required, park_approval_url: r.park_approval_url,
    });
    out.push({
      query: q,
      found: true,
      matches: new Set(all.map((x) => x.route_id)).size,
      title: r.title,
      slug: r.slug,
      park_name: parkName,
      visible: r.is_visible,
      mchs_registration_required: r.mchs_registration_required,
      has_approval_url: webHref(r.park_approval_url) !== null,
      lat: r.lat,
      lng: r.lng,
      parks: hit.filter((x) => x.park_slug).map((x) => ({ park: x.park_slug as string, paths: pathsOf(x) })),
      permit_kind: permit.kind,
      card_block_shown: shown,
      card_wording: shown
        ? permitCardWording(permitCardCase(permit), { hasApprovalUrl: webHref(r.park_approval_url) !== null })
        : null,
      territory_parks: (territoryRows ?? []).map((p) => p.slug),
    });
  }
  return out;
}

/** Бросает, если база не ответила: пустая перепись читалась бы как «таких мест нет». */
export async function runParkScopeCensus(opts: { places?: string[]; routes?: string[] } = {}): Promise<ParkScopeCensus> {
  const started = Date.now();
  const placeSlugs = (opts.places ?? []).slice(0, LOOKUP_LIMIT);
  const routeQueries = (opts.routes ?? []).slice(0, LOOKUP_LIMIT);

  const all = await pool.query<PlaceParkRow>(PLACE_PARK_PATHS_SQL);
  const routeOnlyIds = [...new Set(all.rows.filter((r) => isRouteOnly(pathsOf(r))).map((r) => r.place_id))];
  const lookedUp = placeSlugs.length > 0 ? all.rows.filter((r) => r.slug !== null && placeSlugs.includes(r.slug)) : [];
  const ids = [...new Set([...routeOnlyIds, ...lookedUp.map((r) => r.place_id)])];
  const routes = ids.length > 0
    ? (await pool.query<PlaceParkRouteRow>(PLACE_PARK_ROUTES_SQL, [ids])).rows
    : [];

  const places = countPlacePaths(all.rows, routes);

  const visible = placeSlugs.length > 0
    ? new Set((await pool.query<{ slug: string }>(PLACES_BY_SLUG_SQL, [placeSlugs])).rows.map((r) => r.slug))
    : new Set<string>();
  const placeLookup = placeSlugs.map((slug) => {
    const mine = lookedUp.filter((r) => r.slug === slug);
    return {
      slug,
      // Место есть, а парков нет — правило закрытия его ни в один парк не относит.
      found: visible.has(slug),
      parks: mine.map((r) => ({
        park: r.park_slug,
        paths: pathsOf(r),
        status: r.status,
        status_reason: r.status_reason,
        routes: routes
          .filter((x) => x.place_id === r.place_id && x.park_slug === r.park_slug)
          .map((x) => ({ title: x.title, slug: x.slug, park_name: x.park_name, link_kind: x.link_kind, visible: x.is_visible })),
      })),
    };
  });

  let routeLookup: ParkScopeCensus['lookup']['routes'] = [];
  if (routeQueries.length > 0) {
    const rr = await pool.query<RouteParkRow>(ROUTE_PARK_PATHS_SQL, [routeQueries]);
    const names = [...new Set(rr.rows.map((r) => r.park_name).filter((n): n is string => Boolean(n && n.trim())))];
    const terr = names.length > 0
      ? (await pool.query<{ park_name: string; parks: ParkPermitRow[] | null }>(ROUTE_TERRITORY_PARKS_SQL, [names])).rows
      : [];
    routeLookup = describeRoutes(routeQueries, rr.rows, terr);
  }

  return { places, lookup: { places: placeLookup, routes: routeLookup }, duration_ms: Date.now() - started };
}
