/**
 * Туры на рыбалку для справочника рыб: /fish/[id] и индекс /fish (20.11).
 * Перенесено из app/fish/[id]/page.tsx без изменений.
 */
import { query } from '@/lib/database';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { anyDayOpenSql } from '@/lib/tours/schedule-kind';
import { orderOffersBy } from '@/lib/tours/offer-order';

export interface FishingTour {
  id: number;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  base_price: number;
  operator_name: string;
  /** partners.slug / partners.is_public — страница оператора; закрыта или без адреса — имя текстом (13.10). */
  operator_slug: string | null;
  operator_public: boolean | null;
  duration_hours: number;
  /** Ближайшая дата со свободными местами ('YYYY-MM-DD'); нет — null. Ключ правила 1в. */
  nearest_free_date?: string | null;
  /** Тур «в любой день сезона» открыт сейчас (`anyDayOpenSql`). Ключ правила 1в. */
  any_day_open?: boolean | null;
}

export async function getFishingTours(): Promise<FishingTour[]> {
  try {
    const result = await query<FishingTour>(`
      SELECT ot.id::int, ot.slug, ot.title, ot.base_price::float,
             ot.duration_hours::float,
             p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
             ${nearestFreeDateSql('ot')} AS nearest_free_date, ${anyDayOpenSql('ot')} AS any_day_open
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id
      WHERE ot.activity_type = 'fishing'
        AND ${publicTourSql('ot')}
    `);
    // Порядок — правило 1в (слово владельца 29.10), а не «дешевле выше»;
    // шесть первых — после порядка.
    return orderOffersBy(result.rows, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null, anyDayOpen: r.any_day_open ?? null })).slice(0, 6);
  } catch (e) {
    // Без блока туров, а не с выдуманным, — но отказ виден (§4.0).
    const err = e as { code?: string; message?: string };
    console.error('[fish] туры на рыбалку не прочитаны:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return [];
  }
}
