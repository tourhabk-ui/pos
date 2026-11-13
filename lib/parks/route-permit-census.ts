/**
 * lib/parks/route-permit-census.ts
 *
 * Перепись условий посещения по живым маршрутам (#3302, срез 4).
 *
 * Зачем. Карточка маршрута показывает блок о разрешении парка любому маршруту,
 * у которого записана территория, требуется регистрация в МЧС или есть ссылка
 * согласования, — кроме случаев, которые правило узнаёт по названию. Ответ
 * агенту называет способы КГБУ, только когда справочник парков ведёт
 * территорию на страницу условий КГБУ. Первый прогон (13.11, 368 маршрутов):
 * блок со словами «нужны оба» стоял на 75 карточках, у 52 из них справочник
 * этого не подтверждал. С среза 6 слова блока выбирает то же правило
 * (`permitCardWording`), и перепись считает уже их: где карточка утверждает,
 * где говорит с условием, а где утверждает без подтверждения справочника.
 * Считается на живых данных — тем же правилом (`routePermitCase`) и тем же
 * условием связи со справочником (`routeInParkSql`), что живой ответ.
 *
 * READ-ONLY: ничего не пишет. Названия маршрутов и территорий — публичные
 * данные каталога; ПД в ответе нет.
 */
import { pool } from '@/lib/db-pool';
import { routeInParkSql } from '@/lib/parks/route-in-park';
import {
  lookupFromRows, routePermitCase, type ParkLookup, type ParkPermitRow, type RoutePermitCase,
} from '@/lib/parks/route-permit';
import { permitCardCase, permitCardWording, webHref, type PermitCardWording } from '@/lib/parks/route-permit-card';
import { permitRuleFor } from '@/lib/safety/park-permit';

type Kind = RoutePermitCase['kind'];

const KINDS: readonly Kind[] = [
  'none', 'no_permit', 'kronoki', 'free_visit', 'federal', 'kgbu', 'recorded', 'unrecorded', 'ambiguous', 'unread',
];

const WORDINGS: readonly PermitCardWording[] = ['asserted', 'conditional', 'recorded', 'ambiguous'];

/** Сколько примеров назвать поимённо. */
const UNCONFIRMED_EXAMPLES = 12;

export interface RoutePermitCensus {
  /** Живые (видимые) маршруты. */
  routes_total: number;
  /** Случай ответа агенту — по маршрутам. */
  by_kind: Record<Kind, number>;
  /**
   * Блок о разрешении парка на карточке: правило по названию ничего не решило,
   * а у маршрута записана территория, регистрация в МЧС или ссылка согласования.
   * `by_wording` — что блок говорит (permitCardWording): `asserted` — «нужно
   * разрешение, вот способы»; `conditional` — способы КГБУ с условием «если
   * маршрут идёт по парку сети»; `recorded` — каналы своей записи территории;
   * `ambiguous` — только пояснение. `by_agent_kind` — случай тех же маршрутов в
   * ответе агенту. `asserted_unconfirmed` — блок утверждает, а справочник КГБУ
   * не подтверждает: основание одно — записанная ссылка согласования. Это то,
   * что осталось проверить глазами.
   */
  card_block: {
    total: number;
    by_wording: Record<PermitCardWording, number>;
    by_agent_kind: Record<Kind, number>;
    asserted_unconfirmed_total: number;
    asserted_unconfirmed_examples: Array<{ title: string; park_name: string | null; agent_kind: Kind }>;
  };
  /** Территории, как они записаны у маршрутов: сколько маршрутов и что нашёл справочник. */
  park_names: Array<{ park_name: string; routes: number; parks: string[]; kinds: Partial<Record<Kind, number>> }>;
  duration_ms: number;
}

interface RouteRow {
  title: string | null;
  park_name: string | null;
  mchs_registration_required: boolean | null;
  park_approval_url: string | null;
}

interface NameRow { park_name: string; parks: ParkPermitRow[] | null }

export const CENSUS_ROUTES_SQL = `
  SELECT title, park_name, mchs_registration_required, park_approval_url
    FROM kamchatka_routes
   WHERE is_visible = TRUE`;

/**
 * Строки справочника по каждой записанной территории. Условие связи — то же
 * `routeInParkSql`, что у живого ответа; строк берутся все, чтобы
 * неоднозначность была видна числом, а не спрятана за LIMIT.
 */
export const CENSUS_PARKS_SQL = `
  SELECT n.park_name,
         json_agg(json_build_object(
           'slug', p.slug, 'display_name', p.display_name, 'permit_url', p.permit_url,
           'permit_email', p.permit_email, 'permit_office_address', p.permit_office_address,
           'permit_office_hours', p.permit_office_hours, 'permit_gosuslugi_url', p.permit_gosuslugi_url,
           'permit_online_url', p.permit_online_url) ORDER BY p.slug)
           FILTER (WHERE p.slug IS NOT NULL) AS parks
    FROM (SELECT DISTINCT park_name
            FROM kamchatka_routes
           WHERE is_visible = TRUE AND park_name IS NOT NULL AND btrim(park_name) <> '') n
    LEFT JOIN parks p
      ON p.is_active
     AND ${routeInParkSql('n.park_name', 'p.search_term', 'p.display_name')}
   GROUP BY n.park_name`;

function zeroes(): Record<Kind, number> {
  return Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
}

/**
 * Карточка маршрута показывает блок о разрешении парка — условие блока
 * (app/routes/[id]/_RouteDetailClient) и правило по названию: Вачкажец,
 * территории Кроноцкого заповедника и свободная зона получают свои строки.
 */
export function cardShowsPermitBlock(r: RouteRow): boolean {
  const shown = r.mchs_registration_required === true || Boolean(r.park_name) || Boolean(r.park_approval_url);
  return shown && permitRuleFor({ title: r.title, parkName: r.park_name }).kind === 'park';
}

/** Счёт по уже прочитанным строкам — чистая функция, её и судит сторож. */
export function countRoutePermits(routes: readonly RouteRow[], names: readonly NameRow[]): Omit<RoutePermitCensus, 'duration_ms'> {
  const lookups = new Map<string, ParkLookup>();
  const matched = new Map<string, string[]>();
  for (const n of names) {
    const rows = n.parks ?? [];
    lookups.set(n.park_name, lookupFromRows(rows));
    matched.set(n.park_name, rows.map((p) => p.slug));
  }

  const byKind = zeroes();
  const cardByKind = zeroes();
  const cardByWording = Object.fromEntries(WORDINGS.map((w) => [w, 0])) as Record<PermitCardWording, number>;
  let cardTotal = 0;
  const unconfirmed: RoutePermitCensus['card_block']['asserted_unconfirmed_examples'] = [];
  let unconfirmedTotal = 0;
  const perName = new Map<string, { routes: number; kinds: Partial<Record<Kind, number>> }>();

  for (const r of routes) {
    const parkName = r.park_name && r.park_name.trim() ? r.park_name : null;
    // Территории нет в выборке справочника — её строку не читали: `null`
    // даёт «не прочитано», а не «не записано».
    const lookup = parkName ? lookups.get(parkName) ?? null : null;
    const permit = routePermitCase({ title: r.title, parkName }, lookup);
    const kind = permit.kind;
    byKind[kind] += 1;

    if (parkName) {
      const slot = perName.get(parkName) ?? { routes: 0, kinds: {} };
      slot.routes += 1;
      slot.kinds[kind] = (slot.kinds[kind] ?? 0) + 1;
      perName.set(parkName, slot);
    }

    if (cardShowsPermitBlock(r)) {
      cardTotal += 1;
      cardByKind[kind] += 1;
      const wording = permitCardWording(permitCardCase(permit), { hasApprovalUrl: webHref(r.park_approval_url) !== null });
      cardByWording[wording] += 1;
      if (wording === 'asserted' && kind !== 'kgbu' && kind !== 'federal') {
        unconfirmedTotal += 1;
        if (unconfirmed.length < UNCONFIRMED_EXAMPLES) {
          unconfirmed.push({ title: r.title ?? '', park_name: parkName, agent_kind: kind });
        }
      }
    }
  }

  return {
    routes_total: routes.length,
    by_kind: byKind,
    card_block: {
      total: cardTotal,
      by_wording: cardByWording,
      by_agent_kind: cardByKind,
      asserted_unconfirmed_total: unconfirmedTotal,
      asserted_unconfirmed_examples: unconfirmed,
    },
    park_names: [...perName.entries()]
      .map(([park_name, v]) => ({ park_name, routes: v.routes, parks: matched.get(park_name) ?? [], kinds: v.kinds }))
      .sort((a, b) => b.routes - a.routes || a.park_name.localeCompare(b.park_name, 'ru')),
  };
}

/** Бросает, если база не ответила: пустая перепись читалась бы как «маршрутов нет». */
export async function runRoutePermitCensus(): Promise<RoutePermitCensus> {
  const started = Date.now();
  const [routes, names] = await Promise.all([
    pool.query<RouteRow>(CENSUS_ROUTES_SQL),
    pool.query<NameRow>(CENSUS_PARKS_SQL),
  ]);
  return { ...countRoutePermits(routes.rows, names.rows), duration_ms: Date.now() - started };
}
