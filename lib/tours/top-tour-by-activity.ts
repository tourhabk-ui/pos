/**
 * Тур к дню плана под тип активности — общий резолвер «плана, который
 * бронирует». Используют публичная страница плана (/api/trips/share) и
 * программатик-страницы /plans/[slug]: день плана ведёт на карточку тура
 * с бронью, а не на витрину цен «от-до».
 *
 * Только активные и опубликованные туры; сбой одного подбора не роняет
 * остальные (страница плана обязана открываться и без тур-подсказок).
 *
 * Какой тур из нескольких продавцов вида — решает правило 1в (слово
 * владельца 29.10), а не рейтинг и не цена: первый со свободной датой по
 * ближайшему выезду, иначе — жребий дня (lib/tours/offer-order). До ревью
 * 29.10 здесь стояло `ORDER BY rating DESC, base_price ASC LIMIT 1`, и день
 * плана навсегда отдавал продавца одной компании. Сколько всего туров вида —
 * `offers_of_kind`: страница плана говорит «ещё N» со ссылкой в каталог.
 */

import { pool } from '@/lib/db-pool';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { offerOrderDay, orderOffersBy } from '@/lib/tours/offer-order';

export interface TopTour {
  id: string;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  base_price: string;
  operator_name: string;
  /** partners.slug / partners.is_public — страница оператора; закрыта или без адреса — имя текстом (13.10). */
  operator_slug: string | null;
  operator_public: boolean | null;
  /** Зависимость от погоды — триггер «плана Б» на публичном плане (B-5). */
  weather_dependent: boolean;
  /**
   * Сколько живых туров этого вида всего (подбор по виду); у туров черновика
   * (toursByIds) не считается — там тур выбран самим планом.
   */
  offers_of_kind?: number;
}

/**
 * По каждому типу активности — первый тур по правилу 1в. `day` — день
 * жребия (дата Камчатки); по умолчанию — сегодня.
 */
export async function topToursByActivity(
  activities: string[],
  opts: { day?: string } = {},
): Promise<Record<string, TopTour>> {
  const unique = [...new Set(activities.filter(Boolean))];
  const day = opts.day ?? offerOrderDay();
  const result: Record<string, TopTour> = {};
  await Promise.all(unique.map(async (activity) => {
    try {
      // Без ORDER BY и LIMIT: порядок — правило 1в в TypeScript, после SQL.
      const { rows } = await pool.query<TopTour & { nearest_free_date: string | null }>(`
        SELECT
          ot.id, ot.slug, ot.title, ot.base_price::text,
          COALESCE(ot.weather_dependent, FALSE) AS weather_dependent,
          p.name AS operator_name,
          p.slug AS operator_slug, p.is_public AS operator_public,
          ${nearestFreeDateSql('ot')} AS nearest_free_date
        FROM operator_tours ot
        JOIN partners p ON p.id = ot.operator_id
        WHERE ot.activity_type = $1
          AND ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL
      `, [activity]);
      const [first] = orderOffersBy(rows, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null }), { day });
      if (first) {
        const { nearest_free_date: _date, ...tour } = first;
        void _date;
        result[activity] = { ...tour, offers_of_kind: rows.length };
      }
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
        p.name AS operator_name,
        p.slug AS operator_slug, p.is_public AS operator_public
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
