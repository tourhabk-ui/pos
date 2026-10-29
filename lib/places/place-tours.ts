/**
 * Туры к месту — все предложения, в порядке правила 1в (слово владельца
 * 29.10, «1в 2б 3 да»).
 *
 * Жило блоком внутри карточки места (lib/places/place-detail) с
 * `ORDER BY ot.id LIMIT 5`: шестой тур к месту не показывался никогда, а
 * порядок задавал номер тура — то есть давность заведения, а не что-то, что
 * турист мог бы проверить. К Горелому, Дачным или Мысу Маячному туров у
 * разных компаний уже больше пяти.
 *
 * Теперь:
 *   - туров столько, сколько их есть (LIMIT нет): на карточке места они
 *     сгруппированы по компаниям, и место в списке задаёт правило, а не лимит;
 *   - порядок — lib/tours/offer-order: сначала туры со свободной датой по
 *     ближайшему выезду, остальные — жребий дня. В SQL порядка нет, кроме
 *     `DISTINCT ON` — он выбирает самую сильную связь тура с местом;
 *   - у каждого тура — ближайшая свободная дата (lib/tours/nearest-free-date,
 *     одно условие на все витрины) и признак «ведёт календарь»
 *     (lib/tours/schedule): фразе о датах нужны оба;
 *   - три исхода (§4.0): туры есть / туров нет / «не смог прочитать». Отказ
 *     пишется в лог с SQLSTATE и НЕ роняет карточку места: «туры не
 *     загрузились» — одна строка на карточке, а не 500 вместо места.
 *
 * Связи «тур → место» две, обе явные (аудит 15.10, TOUR-PLACE):
 *   - маршрут тура проходит через место (route_waypoints → kamchatka_routes →
 *     operator_tours.route_id), род связи не «рядом»;
 *   - место названо главным местом тура (operator_tours.main_place_id,
 *     миграции 1286 и 1343, выбор оператора или администратора).
 * Туры через несколько мест (облёты, многодневные по районам) главного места
 * не имеют и сюда не попадают — это называется на карточке словами.
 *
 * Только сервер. Сторожа: tests/unit/place-tours-offers.test.tsx (рендер),
 * tests/integration/public-tour-gate.pg.test.ts (отбор на PostgreSQL).
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { offerOrderDay, orderOffers } from '@/lib/tours/offer-order';
import { logText } from '@/lib/log/log-text';

export type PlaceTourLinkKind = 'main_place' | 'waypoint' | 'unknown';

export interface PlaceTourOffer {
  id: string;
  slug: string | null;
  title: string;
  partnerId: string;
  partnerName: string;
  partnerSlug: string | null;
  /** partners.is_public — ссылка на компанию (OperatorNameLink); null — не прочитано. */
  partnerPublic: boolean | null;
  /** partners.is_verified; «проверен» говорится только при true. */
  partnerVerified: boolean | null;
  /** NULL — цена не записана (не ноль: Number(null) = 0 — ложь, §4.0). */
  basePrice: number | null;
  priceUnit: string | null;
  durationType: string | null;
  multiDayCount: number | null;
  durationHours: number | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  /** Ближайшая дата со свободными местами, 'YYYY-MM-DD'; нет — null. */
  nearestFreeDate: string | null;
  /** Ведёт ли тур календарь (keepsScheduleSql). */
  keepsSchedule: boolean;
  /** = !keepsSchedule: даты по заявке. Производное, для агента. */
  hasDatesByRequest: boolean;
  linkKind: PlaceTourLinkKind;
}

export type PlaceToursResult =
  | { state: 'ok'; day: string; offers: PlaceTourOffer[] }
  | { state: 'empty'; day: string }
  | { state: 'failed' };

/**
 * Отбор туров места. `$1` — places.id. Порядка нет: `ORDER BY` нужен только
 * `DISTINCT ON`, чтобы из нескольких связей тура с местом осталась самая
 * сильная (главное место → точка пути → не размечено).
 */
export const PLACE_TOURS_SQL = `
  SELECT DISTINCT ON (ot.id)
         ot.id::text AS id, ot.slug, ot.title,
         ot.base_price, ot.price_unit,
         ot.duration_type, ot.multi_day_count, ot.duration_hours,
         ot.season_start::text AS season_start, ot.season_end::text AS season_end,
         p.id::text AS partner_id, p.name AS partner_name, p.slug AS partner_slug,
         p.is_public AS partner_public, p.is_verified AS partner_verified,
         ${nearestFreeDateSql('ot')} AS nearest_free_date,
         ${keepsScheduleSql('ot.id')} AS keeps_schedule,
         link.link_kind
    FROM (
      SELECT ot_r.id AS tour_id, COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') AS link_kind
        FROM route_waypoints rw
        JOIN kamchatka_routes kr ON kr.id = rw.route_id
        JOIN operator_tours ot_r ON ot_r.route_id = kr.id
       WHERE rw.place_id = $1
         AND kr.merged_into_id IS NULL
         -- «Туры сюда» — только по маршрутам, которые сюда ИДУТ (03.10):
         -- связь «рядом» (§4.1, миграция 167) приводила на карточку тур к
         -- месту в 15 км от центра своего маршрута.
         AND COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'
      UNION ALL
      SELECT ot_m.id, 'main_place'
        FROM operator_tours ot_m
       WHERE ot_m.main_place_id = $1
    ) link
    JOIN operator_tours ot ON ot.id = link.tour_id
    JOIN partners p ON p.id = ot.operator_id
   -- Шлюз витрины, а не копия флагов (15.10): копия не смотрела deleted_at.
   WHERE ${publicTourSql('ot')}
   ORDER BY ot.id,
     CASE link.link_kind WHEN 'main_place' THEN 0 WHEN 'waypoint' THEN 1 ELSE 2 END`;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function linkKindOf(v: unknown): PlaceTourLinkKind {
  return v === 'main_place' || v === 'waypoint' ? v : 'unknown';
}

/** Строка базы → предложение. Цена NULL или не больше нуля — «не записана». */
export function toPlaceTourOffer(r: Record<string, unknown>): PlaceTourOffer {
  const price = num(r.base_price);
  const keeps = r.keeps_schedule === true;
  return {
    id: String(r.id),
    slug: str(r.slug),
    title: String(r.title ?? ''),
    partnerId: String(r.partner_id ?? ''),
    partnerName: String(r.partner_name ?? ''),
    partnerSlug: str(r.partner_slug),
    partnerPublic: typeof r.partner_public === 'boolean' ? r.partner_public : null,
    partnerVerified: typeof r.partner_verified === 'boolean' ? r.partner_verified : null,
    basePrice: price != null && price > 0 ? price : null,
    priceUnit: str(r.price_unit),
    durationType: str(r.duration_type),
    multiDayCount: num(r.multi_day_count),
    durationHours: num(r.duration_hours),
    seasonStart: str(r.season_start),
    seasonEnd: str(r.season_end),
    nearestFreeDate: str(r.nearest_free_date),
    keepsSchedule: keeps,
    hasDatesByRequest: !keeps,
    linkKind: linkKindOf(r.link_kind),
  };
}

/**
 * Все туры витрины, связанные с местом `placePk` (places.id), в порядке
 * правила 1в. День правила считается один раз и возвращается вместе со
 * списком: группировка и фраза о датах на экране берут тот же день.
 */
export async function loadPlaceTours(placePk: string, opts?: { now?: Date }): Promise<PlaceToursResult> {
  const now = opts?.now ?? new Date();
  const day = offerOrderDay(now);
  try {
    const { rows } = await pool.query<Record<string, unknown>>(PLACE_TOURS_SQL, [placePk]);
    if (rows.length === 0) return { state: 'empty', day };
    return { state: 'ok', day, offers: orderOffers(rows.map(toPlaceTourOffer), { day }) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[place-tours] туры места не прочитаны', {
      placePk: logText(placePk, 80),
      sqlstate: typeof code === 'string' ? logText(code, 10) : null,
      message: logText(err instanceof Error ? err.message : err, 200),
    });
    return { state: 'failed' };
  }
}
