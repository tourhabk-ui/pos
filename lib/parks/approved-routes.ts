/**
 * Утверждённые маршруты природных парков «Налычево», «Быстринский» и
 * «Вилючинский» (КГБУ «Природный парк «Вулканы Камчатки»), слово владельца
 * 20.11: «Сверка и пометка».
 *
 * Источник — страница парка «Туристические маршруты»
 * (`APPROVED_ROUTES_SOURCE`). Парк пишет там: «Передвижение по территории
 * природных парков возможно только по утвержденным маршрутам». Список с
 * сезонами, способом передвижения, паспортом и треком записан миграцией
 * в `park_approved_routes`; связь с нашими маршрутами — `park_approved_route_links`,
 * сверенная по началу, концу и объекту маршрута, а не по похожести имени.
 *
 * Три исхода у карточки маршрута (§4.0):
 *   — `linked`: маршрут есть в списке парка — что, когда и как разрешено;
 *   — `not_listed`: маршрут в одном из трёх парков, а в списке мы его не
 *     нашли — говорится ровно это, «мы не нашли», а не «запрещён»: связь
 *     могла не сложиться и по нашей вине;
 *   — `null`: маршрут вне этих парков, либо чтение не удалось (в лог).
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { routeInParkSql } from '@/lib/parks/route-in-park';
import { PARK_STATUS_FRESH_HOURS, type ParkRouteStatus } from '@/lib/parks/park-route-status';
import {
  APPROVED_ROUTES_PARKS, APPROVED_ROUTES_SOURCE, type ApprovedRouteCase, type ApprovedSeason, type ApprovedVariant,
} from '@/lib/parks/approved-routes-words';

export * from '@/lib/parks/approved-routes-words';


export const APPROVED_FOR_ROUTE_SQL = `
  SELECT pk.display_name AS park_name, a.title, a.season, a.period, a.movement,
         a.passport_urls, a.track_url, a.source_url, a.read_on::text AS read_on,
         CASE WHEN a.status_read_at > NOW() - make_interval(hours => $2::int) THEN a.status END AS status,
         CASE WHEN a.status_read_at > NOW() - make_interval(hours => $2::int)
              THEN to_char(a.status_read_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') END AS status_read_on
    FROM park_approved_route_links l
    JOIN park_approved_routes a ON a.id = l.approved_route_id
    JOIN parks pk ON pk.slug = a.park_slug
   WHERE l.route_id::text = $1::text
   ORDER BY a.title, CASE a.season WHEN 'summer' THEN 0 WHEN 'winter' THEN 1 ELSE 2 END`;

interface Row {
  park_name: string; title: string; season: ApprovedSeason; period: string | null; movement: string | null;
  passport_urls: string[] | null; track_url: string | null; source_url: string; read_on: string;
  status: ParkRouteStatus | null; status_read_on: string | null;
}

/**
 * Только абсолютные http(s)-ссылки. Справочник переписан со страницы парка
 * «Номера маршрутов» (миграция 1468), и одна ссылка там относительная —
 * `marshrut_voshozhdenie_na_avachinskij1.pdf`: битая уже на сайте парка
 * (404), а у нас браузер достраивал её до `/routes/marshrut_….pdf` — 404 на
 * карточке Авачинского (аудит 20.11). Достраивать адрес за источник нельзя:
 * такого файла нет и там.
 */
export function absoluteHttpUrls(urls: readonly string[] | null | undefined): string[] {
  return (urls ?? []).filter((u) => {
    try {
      const p = new URL(u).protocol;
      return p === 'https:' || p === 'http:';
    } catch {
      return false;
    }
  });
}

function toVariant(r: Row): ApprovedVariant {
  return {
    parkName: r.park_name, title: r.title, season: r.season, period: r.period, movement: r.movement,
    passportUrls: absoluteHttpUrls(r.passport_urls), trackUrl: r.track_url, sourceUrl: r.source_url, readOn: r.read_on,
    status: r.status_read_on ? r.status : null, statusReadOn: r.status_read_on,
  };
}

/**
 * Случай маршрута. `parkSlug` — парк маршрута по его `park_name` (то же
 * правило, что у карточки, lib/parks/route-in-park); `parkName` — его имя.
 * Отказ базы — null и строка в логе: карточка тогда молчит, а не говорит
 * «не значится».
 */
export async function approvedRouteCaseFor(
  routeId: string, parkSlug: string | null, parkName: string | null,
): Promise<ApprovedRouteCase | null> {
  try {
    const { rows } = await pool.query<Row>(APPROVED_FOR_ROUTE_SQL, [routeId, PARK_STATUS_FRESH_HOURS]);
    if (rows.length > 0) return { kind: 'linked', variants: rows.map(toVariant) };
    if (parkSlug && (APPROVED_ROUTES_PARKS as readonly string[]).includes(parkSlug) && parkName) {
      return { kind: 'not_listed', parkName, sourceUrl: APPROVED_ROUTES_SOURCE };
    }
    return null;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[approved-routes] утверждённые маршруты не прочитаны:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/** Парк маршрута по его `park_name` — то же правило, что у карточки (lib/routes/route-detail). */
export const ROUTE_PARK_SQL = `
  SELECT slug, display_name FROM parks
   WHERE $1::text IS NOT NULL
     AND ${routeInParkSql('$1::text', 'search_term', 'display_name')}
     AND is_active
   LIMIT 1`;

/**
 * Для MCP и Кузьмича: парк определяется по `park_name` маршрута здесь же.
 * Отказ чтения парка — как отказ всего чтения: null и строка в логе.
 */
export async function approvedRouteCaseByParkName(routeId: string, routeParkName: string | null): Promise<ApprovedRouteCase | null> {
  let park: { slug: string; display_name: string } | undefined;
  try {
    park = (await pool.query<{ slug: string; display_name: string }>(ROUTE_PARK_SQL, [routeParkName])).rows[0];
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[approved-routes] парк маршрута не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
  return approvedRouteCaseFor(routeId, park?.slug ?? null, park?.display_name ?? null);
}

