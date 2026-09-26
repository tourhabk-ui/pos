/**
 * Настоящие предложения к плану поездки: жильё на ночи плана и поездки
 * перевозчиков на даты поездки (решение владельца 26.09). Чистая часть —
 * lib/planner/trip-extras.ts.
 *
 * У каждого ответа три исхода (§4.0): нашли — варианты; искали и нет —
 * `empty`; не смогли проверить — `unavailable`, с именем проверки и
 * SQLSTATE в логе. «Не смог» не выдаётся за «нет».
 *
 * Жильё — только с витрины (publicAccommodationSql: одобрено и не скрыто),
 * только с размеченной зоной планера (planner_zone, миграция 1030; NULL не
 * предлагается — зону не угадываем) и только свободное на ВСЕ ночи стоянки
 * по той же формуле, что каталог и бронь (roomNightsSql). Своего правила
 * занятости здесь нет и заводить его нельзя.
 *
 * Трансферы — только через listPublishedTrips: единственное место с
 * фильтром опубликованности (сторож carrier-api).
 */

import { pool } from '@/lib/db-pool';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { roomNightsSql } from '@/lib/stay/availability';
import { listPublishedTrips } from '@/lib/transfers/service';
import { sqlState } from '@/lib/guides/db-failure';
import { LODGING_OPTIONS_PER_STAY, type LodgingStay } from '@/lib/planner/trip-extras';
import type { ZoneId } from '@/lib/planner/constants';

export type CheckOutcome<T> =
  | { state: 'ok'; items: T[] }
  | { state: 'empty' }
  | { state: 'unavailable' };

export interface LodgingOption {
  id: string;
  name: string;
  type: string;
  /** null — владелец цену не назвал; экран пишет «цена не указана». */
  priceFrom: number | null;
  /** null — отзывов нет; ноль оценкой не является. */
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
}

export interface TransferOption {
  id: string;
  tripDate: string;
  departureNote: string | null;
  fromText: string;
  toText: string;
  seatsFree: number;
  seatsTotal: number;
  /** null — место поштучно не продаётся. */
  pricePerSeat: number | null;
  vehicleKind: string;
  vehicleTitle: string;
  partnerName: string;
}

function logExtrasFailure(check: string, err: unknown): void {
  // Имя проверки и SQLSTATE — без параметров запроса и строк (pd-guard §7).
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[planner/trip-extras] ${check} не выполнился: sqlstate=${sqlState(err)}`, msg);
}

/**
 * SQL подбора жилья на одну стоянку: $1 — зона, $2 — заезд, $3 — выезд,
 * $4 — сколько вариантов. Экспортируется ради сторожа и проверки на базе.
 */
export const LODGING_FOR_STAY_SQL = `
  SELECT a.id, a.name, a.type,
         a.price_per_night_from::text AS price_from,
         a.rating::text AS rating,
         COALESCE(a.review_count, 0)::int AS review_count,
         COALESCE(a.is_verified, false) AS is_verified
    FROM accommodations a
   WHERE ${publicAccommodationSql('a')}
     AND a.planner_zone = $1::varchar
     AND EXISTS (
       SELECT 1 FROM (${roomNightsSql({ accommodation: 'a.id', start: '$2::date', endExclusive: '$3::date' })}) rn
        GROUP BY rn.room_id
       HAVING bool_and(NOT rn.blocked AND rn.free_units > 0)
     )
   ORDER BY a.is_verified DESC, a.rating DESC NULLS LAST, a.price_per_night_from ASC NULLS LAST, a.name
   LIMIT $4`;

/** Объекты витрины без разметки зоны — их планер не предлагает. */
export const UNZONED_PUBLIC_COUNT_SQL = `
  SELECT COUNT(*)::int AS n
    FROM accommodations a
   WHERE ${publicAccommodationSql('a')}
     AND a.planner_zone IS NULL`;

interface LodgingRow {
  id: string;
  name: string;
  type: string;
  price_from: string | null;
  rating: string | null;
  review_count: number;
  is_verified: boolean;
}

export async function findLodgingForStay(stay: LodgingStay): Promise<CheckOutcome<LodgingOption>> {
  try {
    const { rows } = await pool.query<LodgingRow>(LODGING_FOR_STAY_SQL, [
      stay.zone satisfies ZoneId, stay.checkIn, stay.checkOut, LODGING_OPTIONS_PER_STAY,
    ]);
    if (rows.length === 0) return { state: 'empty' };
    return {
      state: 'ok',
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        priceFrom: r.price_from === null ? null : Number(r.price_from),
        // Оценка без отзывов — не оценка (DEFAULT 0 в старых строках).
        rating: r.rating === null || Number(r.review_count) === 0 ? null : Number(r.rating),
        reviewCount: Number(r.review_count),
        isVerified: r.is_verified,
      })),
    };
  } catch (err) {
    logExtrasFailure('подбор жилья на стоянку', err);
    return { state: 'unavailable' };
  }
}

/** null — посчитать не вышло; экран тогда просто молчит об этом числе. */
export async function countUnzonedPublicLodging(): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number }>(UNZONED_PUBLIC_COUNT_SQL);
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    logExtrasFailure('счёт жилья без зоны', err);
    return null;
  }
}

export async function findTransfers(params: {
  fromDate: string;
  toDate: string;
  seats: number;
}): Promise<CheckOutcome<TransferOption>> {
  try {
    const trips = await listPublishedTrips({
      fromDate: params.fromDate,
      toDate: params.toDate,
      minSeats: params.seats,
      placeId: null,
    });
    if (trips.length === 0) return { state: 'empty' };
    return {
      state: 'ok',
      // Только нужное туристу. `comment` перевозчика — свободный текст, в
      // нём бывают телефоны: наружу не отдаётся (pd-guard §2).
      items: trips.slice(0, 6).map((t) => ({
        id: t.id,
        tripDate: t.trip_date,
        departureNote: t.departure_note,
        fromText: t.from_text,
        toText: t.to_text,
        seatsFree: Number(t.seats_free),
        seatsTotal: Number(t.seats_total),
        pricePerSeat: t.price_per_seat === null ? null : Number(t.price_per_seat),
        vehicleKind: t.vehicle_kind,
        vehicleTitle: t.vehicle_title,
        partnerName: t.partner_name,
      })),
    };
  } catch (err) {
    logExtrasFailure('поиск поездок перевозчиков', err);
    return { state: 'unavailable' };
  }
}
