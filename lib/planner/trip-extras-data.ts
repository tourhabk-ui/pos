/**
 * Настоящие предложения к плану поездки: жильё на ночи плана (решение
 * владельца 26.09) и перевозчики «под заказ» — машина целиком (13.10). Чистая
 * часть — lib/planner/trip-extras.ts.
 *
 * У каждого ответа три исхода (§4.0): нашли — варианты; искали и нет —
 * `empty`; не смогли проверить — `unavailable`, с именем проверки и
 * SQLSTATE в логе. «Не смог» не выдаётся за «нет».
 *
 * Жильё — только с витрины (publicAccommodationSql: одобрено и не скрыто),
 * только с размеченной зоной планера (planner_zone, миграция 1031; NULL не
 * предлагается — зону не угадываем) и только свободное на ВСЕ ночи стоянки
 * по той же формуле, что каталог и бронь (roomNightsSql). Своего правила
 * занятости здесь нет и заводить его нельзя.
 *
 * У каждого варианта — цена стоянки на группу (#2304, шаг 3): номера,
 * свободные на все ночи, с вместимостью, остатком и суммой цен ночей из той
 * же формулы; раскладку группы по номерам считает stayPriceForGroup.
 *
 * Трансфер — прайс перевозчиков тем же загрузчиком, что у /transfers
 * (loadCharterCarriers). Места в поездках (схема 926) планер больше не
 * предлагает: до 13.10 он искал «места на всю группу» на даты поездки, а
 * такого товара нет — перевозчик сдаёт машину целиком.
 */

import { pool } from '@/lib/db-pool';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { roomNightsSql } from '@/lib/stay/availability';
import { loadCharterCarriers, describeFleet } from '@/lib/transfers/charter';
import { sqlState } from '@/lib/guides/db-failure';
import {
  LODGING_OPTIONS_PER_STAY, stayPriceForGroup, type LodgingStay, type StayPrice,
} from '@/lib/planner/trip-extras';
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
  /** Цена стоянки на всю группу по правилу брони. */
  stay: StayPrice;
}

/**
 * Перевозчик «под заказ» к плану: машина целиком, цена за машину (владелец
 * 13.10). Только то, что нужно строке плана; телефон и прайс целиком — на
 * странице перевозчика, куда ведёт строка.
 */
export interface CharterOffer {
  slug: string;
  name: string;
  /** «2 × вахтовка, 26 мест»; null — парк не записан. */
  fleet: string | null;
  /** Самая низкая цена строки прайса, ₽ за машину; null — направлений в прайсе нет. */
  priceFromRub: number | null;
  /** Сколько направлений в прайсе. */
  destinations: number;
  /** Цена за машину за час работы (1292), ₽; null — такой цены нет. */
  hourRub: number | null;
  /** Цена за машину за полный день (1292), ₽; null — такой цены нет. */
  dayRub: number | null;
}

function logExtrasFailure(check: string, err: unknown): void {
  // Имя проверки и SQLSTATE — без параметров запроса и строк (pd-guard §7).
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[planner/trip-extras] ${check} не выполнился: sqlstate=${sqlState(err)}`, msg);
}

/**
 * SQL подбора жилья на одну стоянку: $1 — зона, $2 — заезд, $3 — выезд,
 * $4 — сколько вариантов. Объект годится, если хоть один его номер свободен
 * на все ночи; такие номера и отдаются (`rooms`) — с вместимостью, остатком
 * на самую занятую ночь и суммой цен ночей. Экспортируется ради сторожа и
 * проверки на базе.
 */
export const LODGING_FOR_STAY_SQL = `
  SELECT a.id, a.name, a.type,
         a.price_per_night_from::text AS price_from,
         a.rating::text AS rating,
         COALESCE(a.review_count, 0)::int AS review_count,
         COALESCE(a.is_verified, false) AS is_verified,
         fit.rooms
    FROM accommodations a
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'room_id', x.room_id, 'name', x.name, 'max_guests', x.max_guests,
               'min_free', x.min_free, 'stay_sum', x.stay_sum)), '[]'::jsonb) AS rooms
        FROM (
          SELECT rn.room_id, r.name, r.max_guests,
                 MIN(rn.free_units)::int AS min_free,
                 SUM(rn.price) AS stay_sum
            FROM (${roomNightsSql({ accommodation: 'a.id', start: '$2::date', endExclusive: '$3::date' })}) rn
            JOIN accommodation_rooms r ON r.id::text = rn.room_id
           GROUP BY rn.room_id, r.name, r.max_guests
          HAVING bool_and(NOT rn.blocked AND rn.free_units > 0)
        ) x
    ) fit
   WHERE ${publicAccommodationSql('a')}
     AND a.planner_zone = $1::varchar
     AND jsonb_array_length(fit.rooms) > 0
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
  rooms: Array<{ room_id: string; name: string; max_guests: number; min_free: number; stay_sum: number | string }>;
}

export async function findLodgingForStay(stay: LodgingStay, people: number): Promise<CheckOutcome<LodgingOption>> {
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
        stay: stayPriceForGroup(
          (r.rooms ?? []).map((m) => ({
            roomId: m.room_id, name: m.name, maxGuests: Number(m.max_guests),
            minFree: Number(m.min_free), staySum: Number(m.stay_sum),
          })),
          people,
        ),
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

/**
 * Трансфер к плану — перевозчики «под заказ» (владелец 13.10: «бронируют
 * целую машину а не место в ней»). От дат плана не зависит: прайс один на
 * сезон, а направление и даты заказчик пишет в заявке перевозчику.
 */
export async function findCharterOffers(): Promise<CheckOutcome<CharterOffer>> {
  try {
    const carriers = await loadCharterCarriers();
    if (carriers.length === 0) return { state: 'empty' };
    return {
      state: 'ok',
      items: carriers.map((c) => ({
        slug: c.slug,
        name: c.name,
        fleet: describeFleet(c.vehicles, c.seatClasses),
        priceFromRub: c.destinations.length > 0 ? Math.min(...c.destinations.map((d) => d.priceRub)) : null,
        destinations: c.destinations.length,
        hourRub: c.rates.find((r) => r.unit === 'hour')?.priceRub ?? null,
        dayRub: c.rates.find((r) => r.unit === 'day')?.priceRub ?? null,
      })),
    };
  } catch (err) {
    logExtrasFailure('прайс машин под заказ', err);
    return { state: 'unavailable' };
  }
}
