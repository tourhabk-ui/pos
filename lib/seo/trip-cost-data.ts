/**
 * Чтение для страниц «Сколько стоит поездка» и «Когда ехать» (lib/seo/trip-cost).
 *
 * Витрина — те же предикаты, что каталог, MCP и llms.txt: туры —
 * publicTourSql, жильё — publicAccommodationSql, перевозчики —
 * loadCharterCarriers. У каждого чтения три исхода (§4.0): строки, пусто,
 * null — «не прочиталось», и тогда страница говорит «не загрузилось», а не
 * «нет»; SQLSTATE — в лог.
 */
import { cache } from 'react';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { loadCharterCarriers } from '@/lib/transfers/charter';
import type { CharterCarrier } from '@/lib/transfers/charter-format';
import { logText } from '@/lib/log/log-text';
import type { CostStayRow, CostTourRow } from '@/lib/seo/trip-cost';

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(`[trip-cost] ${what} не прочитаны:`, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет', logText(err instanceof Error ? err.message : err, 200));
}

export interface TripCostData {
  tours: CostTourRow[] | null;
  stays: CostStayRow[] | null;
  carriers: Pick<CharterCarrier, 'destinations'>[] | null;
}

export const TRIP_COST_TOURS_SQL = `
  SELECT ot.base_price::text AS base_price, ot.price_unit, ot.activity_type::text AS activity_type,
         ot.season_start::text AS season_start, ot.season_end::text AS season_end
    FROM operator_tours ot
    JOIN partners p ON p.id = ot.operator_id
   WHERE ${publicTourSql('ot')}`;

export const TRIP_COST_STAYS_SQL = `
  SELECT a.price_per_night_from::text AS price_per_night_from
    FROM accommodations a
   WHERE ${publicAccommodationSql('a')}`;

export const loadTripCost = cache(async (): Promise<TripCostData> => {
  const [tours, stays, carriers] = await Promise.all([
    pool.query<CostTourRow>(TRIP_COST_TOURS_SQL).then((r) => r.rows, (e: unknown) => { logFail('туры', e); return null; }),
    pool.query<CostStayRow>(TRIP_COST_STAYS_SQL).then((r) => r.rows, (e: unknown) => { logFail('жильё', e); return null; }),
    loadCharterCarriers().then((c) => c, (e: unknown) => { logFail('перевозчики', e); return null; }),
  ]);
  return { tours, stays, carriers };
});
