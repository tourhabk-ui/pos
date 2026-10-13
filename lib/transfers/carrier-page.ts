/**
 * Данные страницы перевозчика /transfers/[slug] — стандарт карточки трансфера
 * (решение владельца 13.10, «да делай»; CLAUDE.md §14).
 *
 * Три части с тремя исходами каждая, а не одна «загрузилось/нет»:
 *   · перевозчик — нашли / такого нет (404) / не смогли проверить (исключение,
 *     страница падает в ошибку, а не рисует «перевозчика нет»);
 *   · поездки с датами — список / пусто («под заказ», это норма) / не смогли;
 *   · опасности мест по направлениям — по месту / место без профиля
 *     («не записаны» ≠ «безопасно») / не смогли;
 *   · отзывы — список со сводкой по видимым / пусто / не смогли (миграция
 *     1235, lib/transfers/carrier-reviews).
 * Отказ второстепенной части не роняет страницу: прайс и заявка важнее.
 */

import { query } from '@/lib/database';
import { loadCarrierBySlug } from '@/lib/transfers/charter';
import type { CarrierProfile, CharterVehicleKind } from '@/lib/transfers/charter-format';
import { listPublishedTrips } from '@/lib/transfers/service';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { tripsLink } from '@/lib/transfers/trips-link';
import { addDays } from '@/lib/transfers/charter-request-service';
import { logText } from '@/lib/log/log-text';
import { asProfileSource, mayStateAsFact } from '@/lib/safety/profile-source';
import { loadCarrierReviews, type CarrierReviewsBlock } from '@/lib/transfers/carrier-reviews';

/** Окно поездок с датами — то же, что у витрины /transfers и search_transfers. */
export const CARRIER_TRIPS_WINDOW_DAYS = 60;

export interface CarrierTripView {
  id: string;
  date: string;
  from: string;
  to: string;
  departureNote: string | null;
  seatsFree: number;
  seatsTotal: number;
  /** Цена места; null — не названа (поездка могла уйти под одну группу). */
  pricePerSeat: number | null;
  vehicleKind: CharterVehicleKind;
  vehicleTitle: string;
  /** Витрина с этой поездкой в фокусе — там запрос мест. */
  href: string;
}

export type CarrierTrips = { state: 'ok'; items: CarrierTripView[]; windowDays: number } | { state: 'failed' };

/** placeId → опасности; места без профиля безопасности в карте нет. */
export type DestinationSafety = { state: 'ok'; byPlace: Record<string, string[]> } | { state: 'failed' };

export interface CarrierPageData {
  carrier: CarrierProfile;
  trips: CarrierTrips;
  safety: DestinationSafety;
  reviews: CarrierReviewsBlock;
}

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[transfers/carrier-page] ${what}: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    logText(err instanceof Error ? err.message : err, 200),
  );
}

async function loadTrips(partnerId: string, today: string): Promise<CarrierTrips> {
  try {
    const rows = await listPublishedTrips({
      fromDate: today,
      toDate: addDays(today, CARRIER_TRIPS_WINDOW_DAYS),
      partnerId,
    });
    return {
      state: 'ok',
      windowDays: CARRIER_TRIPS_WINDOW_DAYS,
      items: rows.map((t) => ({
        id: t.id,
        date: t.trip_date,
        from: t.from_text,
        to: t.to_text,
        departureNote: t.departure_note,
        seatsFree: t.seats_free,
        seatsTotal: t.seats_total,
        pricePerSeat: t.price_per_seat === null ? null : Number(t.price_per_seat),
        vehicleKind: t.vehicle_kind,
        vehicleTitle: t.vehicle_title,
        href: tripsLink({ from: t.trip_date, to: t.trip_date, seats: 1, tripId: t.id }),
      })),
    };
  } catch (err) {
    logFailure('поездки не прочитаны', err);
    return { state: 'failed' };
  }
}

/**
 * Опасности мест, куда идёт машина: location_safety_profile по ark_id места —
 * тот же источник, что у карточки места (§9). Профилей у места может быть
 * несколько — опасности объединяются, порядок первого появления.
 *
 * Опасности, доказанно пришедшие шаблоном по типу места (миграция 070:
 * «вулкан — лавины, камнепад, термальные, высота»), как факт не произносятся
 * (lib/safety/profile-source): у такого места — «не записаны», как и у места
 * без профиля.
 */
async function loadDestinationSafety(placeIds: string[]): Promise<DestinationSafety> {
  if (placeIds.length === 0) return { state: 'ok', byPlace: {} };
  try {
    const { rows } = await query<{ place_id: string; hazard_types: string[] | null; profile_source: unknown }>(
      `SELECT pl.id AS place_id, lsp.hazard_types, lsp.profile_source
         FROM places pl
         JOIN location_safety_profile lsp ON lsp.agent_route_id = pl.ark_id
        WHERE pl.id = ANY($1::text[])`,
      [placeIds],
    );
    const byPlace: Record<string, string[]> = {};
    for (const r of rows) {
      if (!mayStateAsFact(asProfileSource(r.profile_source))) continue;
      const list = byPlace[r.place_id] ?? (byPlace[r.place_id] = []);
      for (const h of r.hazard_types ?? []) if (h && !list.includes(h)) list.push(h);
    }
    return { state: 'ok', byPlace };
  } catch (err) {
    logFailure('опасности мест не прочитаны', err);
    return { state: 'failed' };
  }
}

/** null — такого перевозчика нет; отказ чтения перевозчика — исключение. */
export async function loadCarrierPage(slug: string, today: string = kamchatkaToday()): Promise<CarrierPageData | null> {
  const carrier = await loadCarrierBySlug(slug);
  if (!carrier) return null;
  const placeIds = [...new Set(carrier.destinations.flatMap((d) => (d.place ? [d.place.id] : [])))];
  const [trips, safety, reviews] = await Promise.all([
    loadTrips(carrier.partnerId, today),
    loadDestinationSafety(placeIds),
    loadCarrierReviews(carrier.partnerId),
  ]);
  return { carrier, trips, safety, reviews };
}
