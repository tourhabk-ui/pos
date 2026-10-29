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
import {
  OFFER_ORDER_NOTE_AGENT, groupOffersByCompany, offerDatesPhrase, offerOrderDay, offersSummary, orderOffers,
} from '@/lib/tours/offer-order';
import { priceWithUnitWords } from '@/lib/tours/price-label';
import { tourPath } from '@/lib/tours/tour-url';
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

// ── Тур на «туры к месту» (агент и карточка тура) ───────────────────────

/** Связь «тур идёт к этому месту»: главное место или точка пути маршрута. */
export function goesToPlace(o: Pick<PlaceTourOffer, 'linkKind'>): boolean {
  return o.linkKind === 'main_place' || o.linkKind === 'waypoint';
}

/**
 * Строки предложений места для агента (get_place_info, MCP fetch place:).
 * Компания за компанией в порядке правила 1в, у каждого тура — компания,
 * цена с единицей словами и фраза о датах. Порядок назван строкой правила:
 * агент пересказывает его, а не выдумывает «лучший» тур. `base` — адрес
 * сайта без «/» в конце: ссылки у внешнего агента должны быть полными.
 */
export function offerLinesForAgent(placeName: string, r: PlaceToursResult, base: string): string[] {
  if (r.state === 'failed') {
    return [`Туры к месту «${placeName}» не загрузились (сбой базы). Не говори, что туров нет.`];
  }
  if (r.state === 'empty') return [`К месту «${placeName}» туров на витрине нет.`];
  const line = (t: PlaceTourOffer): string => {
    const company = `${t.partnerName}${t.partnerVerified === true ? ' (проверен)' : ''}`;
    const price = priceWithUnitWords(t.basePrice, t.priceUnit) ?? 'цена не указана';
    const dates = offerDatesPhrase({
      nearestFreeDate: t.nearestFreeDate, keepsSchedule: t.keepsSchedule,
      season_start: t.seasonStart, season_end: t.seasonEnd, duration_type: t.durationType,
      multi_day_count: t.multiDayCount, duration_hours: t.durationHours,
    }, r.day, 'ok');
    return `- ID${t.id} «${t.title}» — ${company} — ${price} — ${dates} — ${base}${tourPath(t)}`;
  };
  const listOf = (offers: PlaceTourOffer[]): string[] =>
    groupOffersByCompany(offers, { day: r.day }).flatMap((g) => g.tours.map(line));
  const here = r.offers.filter(goesToPlace);
  const unmarked = r.offers.filter((o) => !goesToPlace(o));
  const out: string[] = [];
  if (here.length > 0) {
    const companies = new Set(here.map((o) => o.partnerId)).size;
    out.push(`К месту «${placeName}» ${offersSummary(here.length, companies)} (только туры со связью «к этому месту»). ${OFFER_ORDER_NOTE_AGENT}`);
    out.push(...listOf(here));
  }
  if (unmarked.length > 0) {
    out.push(here.length > 0
      ? 'По маршрутам, связанным с местом (проходит ли тур через само место — не размечено):'
      : `К месту «${placeName}» туров со связью «к этому месту» нет. По маршрутам, связанным с местом (проходит ли тур через само место — не размечено). ${OFFER_ORDER_NOTE_AGENT}`);
    out.push(...listOf(unmarked));
  }
  out.push('Туры, которые проходят через несколько мест (облёты, многодневные), здесь не перечислены.');
  return out;
}

export interface OfferPlace {
  id: string;
  name: string;
  slug: string | null;
  ark_id: string | null;
}

/** Другие предложения к главному месту тура: три исхода и «связи нет». */
export type PlaceOffersForTour =
  | { state: 'ok'; place: OfferPlace; others: number }
  | { state: 'none' }
  | { state: 'failed' };

/**
 * Сколько ещё туров идёт к главному месту тура (слово владельца 29.10, «3 да»).
 * Только по записанной связи `operator_tours.main_place_id`: связь не
 * выводится ни по координате, ни по имени (§4.1). Считаются туры, которые
 * карточка места показывает в «Туры к этому месту», без самого тура — тем же
 * загрузчиком, поэтому число совпадает с тем, что турист увидит по ссылке.
 * Места нет, оно скрыто или слито — `none`; отказ базы — `failed` с логом.
 */
export async function loadPlaceOffersForTour(
  tour: { id: string | number; main_place_id: string | null | undefined },
  opts?: { now?: Date },
): Promise<PlaceOffersForTour> {
  const placeId = typeof tour.main_place_id === 'string' ? tour.main_place_id.trim() : '';
  if (!placeId) return { state: 'none' };
  let place: OfferPlace | undefined;
  try {
    const { rows } = await pool.query<{ id: string; name: string; slug: string | null; ark_id: string | null }>(
      `SELECT id::text AS id, name, slug, ark_id::text AS ark_id
         FROM places
        WHERE id = $1 AND is_visible = TRUE AND merged_into_id IS NULL`,
      [placeId],
    );
    place = rows[0];
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[place-tours] главное место тура не прочитано', {
      tourId: logText(String(tour.id), 20),
      sqlstate: typeof code === 'string' ? logText(code, 10) : null,
      message: logText(err instanceof Error ? err.message : err, 200),
    });
    return { state: 'failed' };
  }
  if (!place) return { state: 'none' };
  const r = await loadPlaceTours(place.id, opts);
  if (r.state === 'failed') return { state: 'failed' };
  const self = String(tour.id);
  const others = r.state === 'ok' ? r.offers.filter((o) => goesToPlace(o) && o.id !== self).length : 0;
  return { state: 'ok', place: { id: place.id, name: place.name, slug: place.slug ?? null, ark_id: place.ark_id ?? null }, others };
}
