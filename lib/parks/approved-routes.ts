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

export const APPROVED_ROUTES_SOURCE = 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/';

/** Парки, чей список утверждённых маршрутов записан. */
export const APPROVED_ROUTES_PARKS = ['nalychevo', 'bystrinskiy', 'vilyuchinsky'] as const;

export const PARK_RULE_QUOTE = 'Передвижение по территории природных парков возможно только по утвержденным маршрутам.';

export type ApprovedSeason = 'summer' | 'winter' | 'all';

export interface ApprovedVariant {
  parkName: string;
  title: string;
  season: ApprovedSeason;
  /** «июнь-октябрь» словами парка; null — на странице не указан. */
  period: string | null;
  /** Способ передвижения словами парка; null — не указан. */
  movement: string | null;
  passportUrls: string[];
  trackUrl: string | null;
  sourceUrl: string;
  /** Когда прочитана страница парка, 'YYYY-MM-DD'. */
  readOn: string;
}

export type ApprovedRouteCase =
  | { kind: 'linked'; variants: ApprovedVariant[] }
  | { kind: 'not_listed'; parkName: string; sourceUrl: string };

export const APPROVED_FOR_ROUTE_SQL = `
  SELECT pk.display_name AS park_name, a.title, a.season, a.period, a.movement,
         a.passport_urls, a.track_url, a.source_url, a.read_on::text AS read_on
    FROM park_approved_route_links l
    JOIN park_approved_routes a ON a.id = l.approved_route_id
    JOIN parks pk ON pk.slug = a.park_slug
   WHERE l.route_id::text = $1::text
   ORDER BY a.title, CASE a.season WHEN 'summer' THEN 0 WHEN 'winter' THEN 1 ELSE 2 END`;

interface Row {
  park_name: string; title: string; season: ApprovedSeason; period: string | null; movement: string | null;
  passport_urls: string[] | null; track_url: string | null; source_url: string; read_on: string;
}

function toVariant(r: Row): ApprovedVariant {
  return {
    parkName: r.park_name, title: r.title, season: r.season, period: r.period, movement: r.movement,
    passportUrls: r.passport_urls ?? [], trackUrl: r.track_url, sourceUrl: r.source_url, readOn: r.read_on,
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
    const { rows } = await pool.query<Row>(APPROVED_FOR_ROUTE_SQL, [routeId]);
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

const SEASON_WORD: Record<ApprovedSeason, string> = { summer: 'летом', winter: 'зимой', all: 'круглый год' };

function readOnWords(d: string): string {
  return d.split('-').reverse().join('.');
}

/** Один вариант словами: «летом (июнь-октябрь): передвижение пешком». */
export function variantWords(v: ApprovedVariant): string {
  const when = v.period ? `${SEASON_WORD[v.season]} (${v.period})` : SEASON_WORD[v.season];
  return v.movement ? `${when}: ${v.movement.replace(/\.$/, '')}` : `${when}: способ передвижения на странице парка не указан`;
}

/**
 * Строки для карточки, Кузьмича и MCP — одни слова на всех. Статус «открыт /
 * закрыт» здесь не утверждается: он меняется, и его читает отдельный слой.
 */
export function approvedRouteLines(c: ApprovedRouteCase | null): string[] {
  if (!c) return [];
  if (c.kind === 'not_listed') {
    return [
      `Среди утверждённых маршрутов парка (${c.parkName}) мы этот маршрут не нашли. Парк пишет: «${PARK_RULE_QUOTE}» Список — ${c.sourceUrl}`,
    ];
  }
  const byTitle = new Map<string, ApprovedVariant[]>();
  for (const v of c.variants) byTitle.set(`${v.parkName}|${v.title}`, [...(byTitle.get(`${v.parkName}|${v.title}`) ?? []), v]);
  const lines: string[] = [];
  for (const vs of byTitle.values()) {
    const v0 = vs[0]!;
    lines.push(`Утверждённый маршрут парка (${v0.parkName}): «${v0.title}» — ${vs.map(variantWords).join('; ')}.`);
  }
  const first = c.variants[0]!;
  lines.push(`Паспорт маршрута и GPS-трек — на сайте парка; источник: ${first.sourceUrl} (прочитано ${readOnWords(first.readOn)}).`);
  return lines;
}
