/**
 * Лучший реальный тур под тип активности — общий резолвер «плана, который
 * бронирует». Используют публичная страница плана (/api/trips/share) и
 * программатик-страницы /plans/[slug]: день плана ведёт на карточку тура
 * с бронью, а не на витрину цен «от-до».
 *
 * Только активные и опубликованные туры; сбой одного подбора не роняет
 * остальные (страница плана обязана открываться и без тур-подсказок).
 */

import { pool } from '@/lib/db-pool';

export interface TopTour {
  id: string;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  base_price: string;
  operator_name: string;
  /** Зависимость от погоды — триггер «плана Б» на публичном плане (B-5). */
  weather_dependent: boolean;
}

/** По каждому типу активности — лучший тур (рейтинг, затем цена). */
export async function topToursByActivity(activities: string[]): Promise<Record<string, TopTour>> {
  const unique = [...new Set(activities.filter(Boolean))];
  const result: Record<string, TopTour> = {};
  await Promise.all(unique.map(async (activity) => {
    try {
      const { rows } = await pool.query<TopTour>(`
        SELECT
          ot.id, ot.slug, ot.title, ot.base_price::text,
          COALESCE(ot.weather_dependent, FALSE) AS weather_dependent,
          p.name AS operator_name
        FROM operator_tours ot
        JOIN partners p ON p.id = ot.operator_id
        WHERE ot.activity_type = $1
          AND ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL
        ORDER BY ot.rating DESC NULLS LAST, ot.base_price ASC
        LIMIT 1
      `, [activity]);
      if (rows[0]) result[activity] = rows[0];
    } catch (e) {
      // Тур-подсказка необязательна, но отказ подбора — в лог (§4.0).
      console.error('[top-tour-by-activity] подбор не выполнен', {
        activity, code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
      });
    }
  }));
  return result;
}

/**
 * Туры по id — для черновика плана (#2225): тур дня там уже выбран самим
 * планом, и страница показывает его, а не лучший по типу занятия. Только
 * активные и опубликованные: тур, снятый после сборки плана, на странице не
 * показывается (день остаётся без тура), а не ведёт на мёртвую карточку.
 * Отказ — пустой результат и строка в логе: страница плана открывается и без
 * тур-подсказок, как и при подборе по типу.
 */
export async function toursByIds(ids: string[]): Promise<Record<string, TopTour>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  try {
    const { rows } = await pool.query<TopTour>(`
      SELECT
        ot.id::text AS id, ot.slug, ot.title, ot.base_price::text,
        COALESCE(ot.weather_dependent, FALSE) AS weather_dependent,
        p.name AS operator_name
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id
      WHERE ot.id::text = ANY($1::text[])
        AND ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL
    `, [unique]);
    return Object.fromEntries(rows.map((r) => [String(r.id), r]));
  } catch (e) {
    console.error('[top-tour-by-activity] туры плана не прочитаны', {
      count: unique.length, code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}
