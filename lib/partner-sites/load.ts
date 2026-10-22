/**
 * Данные сайта партнёра, который отдаёт Ведар (lib/partner-sites/registry).
 *
 * Те же строки, что у страницы оператора /operators/[slug]: профиль из
 * `partners` и живые туры из `operator_tours` за шлюзом витрины
 * (`publicTourSql`). Сайт и карточки на Ведаре читают одну базу — разойтись им
 * негде (вопросы к партнёру 22.10 нашли шесть расхождений сайта на Tilda с
 * карточками).
 *
 * Отказ базы — не «партнёра нет»: исключение уходит наверх, и страница
 * отвечает ошибкой, а не 404 (§4.0).
 */
import { cache } from 'react';
import { query } from '@/lib/database';
import type { OperatorProfileRow, PartnerSiteTourRow } from '@/lib/types/db-rows';
import { publicTourSql } from '@/lib/tours/public-visibility';

export interface PartnerSiteData {
  profile: OperatorProfileRow;
  tours: PartnerSiteTourRow[];
}

/**
 * Один запрос на рендер: метаданные и страница читают одно и то же (React cache).
 * Партнёр — по id из реестра, не по slug: slug меняется (22.10 предпросмотр
 * по slug отвечал 404).
 */
export const loadPartnerSite = cache(async (partnerId: string): Promise<PartnerSiteData | null> => {
  const profiles = await query<OperatorProfileRow>(
    `SELECT id::text AS id, slug, name, category, description, short_description,
            hero_image, logo_image, gallery, services, features, faq, season_info,
            reviews_data, contacts, location, legal_info, contact,
            rating::text, review_count::text, is_verified,
            registry_status, registry_number,
            to_char(registry_checked_at AT TIME ZONE 'Asia/Kamchatka', 'DD.MM.YYYY') AS registry_checked_at,
            created_at::text
       FROM partners
      WHERE id::text = $1::text AND is_public = TRUE
      LIMIT 1`,
    [partnerId],
  );
  const profile = profiles.rows[0];
  if (!profile) return null;

  const tours = await query<PartnerSiteTourRow>(
    `SELECT ot.id::text AS id, ot.slug, ot.title, ot.short_description,
            ot.base_price::text AS base_price, ot.price_unit,
            ot.duration_type, ot.multi_day_count,
            to_char(ot.season_start, 'DD.MM.YYYY') AS season_start,
            to_char(ot.season_end, 'DD.MM.YYYY') AS season_end,
            ot.photos, ot.tour_image,
            ot.included, ot.not_included, ot.min_participants, ot.max_participants
       FROM operator_tours ot
      WHERE ot.operator_id::text = $1::text AND ${publicTourSql('ot')}
      ORDER BY (ot.pinned_at IS NULL), ot.pinned_at, ot.season_start NULLS LAST, ot.id`,
    [profile.id],
  );
  return { profile, tours: tours.rows };
});
