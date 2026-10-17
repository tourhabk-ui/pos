/**
 * Туры для посадочных страниц (lib/seo/query-landings) — из базы на запросе.
 *
 * Витрина — тот же предикат, что каталог, /zh и sitemap (publicTourSql).
 * Порядок — то же единственное правило, что у /zh: компания, затем тур
 * (orderZhTours), без поднятий (CLAUDE.md §0). Ближайшая открытая дата —
 * то же условие, что has_availability каталога (hasAvailabilitySql), только
 * MIN(date). Отказ базы — null и SQLSTATE в лог: страница говорит
 * «не загрузилось», а не показывает пустой список (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { logText } from '@/lib/log/log-text';
import { orderZhTours, withZhTitles, type ZhTourRow } from '@/lib/zh/entry';
import type { LandingTopic } from '@/lib/seo/query-landings';

export interface LandingTourRow extends ZhTourRow {
  season_start: string | null;
  season_end: string | null;
  /** Ближайшая дата со свободными местами, 'YYYY-MM-DD'; нет — null (по запросу). */
  next_open_date: string | null;
}

/** SQL-условие темы. Строки фиксированы в коде, ввода пользователя нет. */
export function topicSql(topic: LandingTopic): string {
  switch (topic) {
    case 'all': return 'TRUE';
    case 'bears': return `(ot.activity_type IN ('bears','bear_watching') OR ot.title ILIKE '%медвед%' OR ot.short_description ILIKE '%медвед%')`;
    case 'volcano': return `(ot.activity_type = 'volcano' OR ot.title ILIKE '%вулкан%' OR ot.short_description ILIKE '%вулкан%')`;
    default: throw new Error(`topicSql: неизвестная тема ${String(topic)}`);
  }
}

export function landingToursSql(topic: LandingTopic): string {
  return `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours,
              ot.season_start::text AS season_start, ot.season_end::text AS season_end,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
              (SELECT MIN(ta.date)::text FROM tour_availability ta
                WHERE ta.operator_tour_id = ot.id
                  AND ta.date >= CURRENT_DATE
                  AND ta.deleted_at IS NULL
                  AND ta.is_cancelled = false
                  AND ta.available_slots > (${occupiedOnDaySql({ booking: 'ob2', day: 'ta.date', tourId: 'ot.id' })})
              ) AS next_open_date
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')} AND ${topicSql(topic)}`;
}

export async function loadLandingTours(topic: LandingTopic, withZh: boolean): Promise<LandingTourRow[] | null> {
  try {
    const { rows } = await pool.query<LandingTourRow>(landingToursSql(topic));
    return orderZhTours(withZh ? await withZhTitles(rows) : rows);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[query-landing] туры не прочитаны:', topic, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}
