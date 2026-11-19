/**
 * Данные двух страниц-ответов (lib/seo/trip-guides): туры витрины и цены
 * жилья. Туры — тот же загрузчик, что у посадочных (`loadLandingTours('all')`:
 * витрина publicTourSql, порядок правила 1в), так что цифры страниц не могут
 * разойтись с каталогом. Отказ базы — null и SQLSTATE в лог: страница говорит
 * «не загрузилось», а не «туров нет» (§4.0).
 */
import { cache } from 'react';
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { loadLandingTours, type LandingTourRow } from '@/lib/seo/query-landings-data';
import type { StayPrices } from '@/lib/seo/trip-guides';

/** Туры витрины один раз на запрос: их читают и метаданные, и сама страница. */
export const loadGuideTours = cache((): Promise<LandingTourRow[] | null> => loadLandingTours('all', false));

export function stayPricesSql(): string {
  const priced = `a.price_per_night_from > 0 AND COALESCE(a.currency, 'RUB') = 'RUB'`;
  return `SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE ${priced})::int AS priced,
                 MIN(a.price_per_night_from) FILTER (WHERE ${priced})::text AS min,
                 MAX(a.price_per_night_from) FILTER (WHERE ${priced})::text AS max
            FROM accommodations a
           WHERE ${publicAccommodationSql('a')}`;
}

/** Цены жилья витрины; база не ответила — null. */
export async function loadStayPrices(): Promise<StayPrices | null> {
  try {
    const { rows } = await pool.query<{ total: number; priced: number; min: string | null; max: string | null }>(stayPricesSql());
    const r = rows[0];
    if (!r) return null;
    const num = (v: string | null) => (v == null ? null : Number(v));
    return { total: Number(r.total), priced: Number(r.priced), min: num(r.min), max: num(r.max) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[trip-guides] цены жилья не прочитаны:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}
