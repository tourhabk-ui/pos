/**
 * Перепись маршрутов без адреса по имени — кто держит их адрес (14.10).
 *
 * Перепись sitemap (прогон 7) насчитала 133 маршрута из 370, открывающихся по
 * UUID. Первый прогон этой переписи на проде (14.10) показал: у всех 133 адрес
 * держит место (125) или скрытый маршрут-тёзка (8). Владелец решил по именам
 * (тот же путь, что `place-slug-census` перед 1112): маршрут к месту —
 * `<имя>-marshrut`, адрес скрытого тёзки — видимому (миграция 1239). Теперь
 * перепись называет остаток, которого правило не решает: тёзки, место при
 * занятом `<имя>-marshrut`, адрес у другого маршрута — видимого, скрытого
 * (перенос 1239 разовый) или слитого.
 *
 * Здесь — запрос и классификация одним местом: роут
 * `/api/cron/route-slug-census` их только зовёт, а сторож на настоящем
 * PostgreSQL исполняет тот же запрос (tests/integration/route-slug-on-write).
 */
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';

/**
 * Адреса под `/routes/`, которые маршруту не выдаются: разделы
 * (`/routes/rybalka` — страница раздела, она проверяется раньше маршрута) и
 * статичный сегмент `app/routes/tour`. Тот же список литералом стоит в
 * `route_slug_candidate` (миграция 1237) — SQL не умеет импортировать, и
 * связку держит сторож на настоящем PostgreSQL.
 */
export const ROUTE_RESERVED_SLUGS: readonly string[] = [...Object.keys(CATEGORY_PAGES), 'tour'];

/**
 * Видимые и не слитые маршруты без адреса — с держателем их адреса по имени.
 * `$1` — адреса разделов `/routes/<раздел>` (страница раздела перекрывает
 * маршрут с таким адресом). `would_assign` — что выдало бы правило записи
 * сейчас: не NULL у кого-то — значит маршрут стал видимым мимо триггера.
 * Только чтение.
 */
export const ROUTE_SLUG_CENSUS_SQL = `
  WITH missing AS (
    SELECT r.id, r.id::text AS id_text, r.title, translit_ru_slug(r.title) AS base,
           r.slug = '' AS empty_slug, r.created_at, r.activity_type,
           r.geometry->>'source' AS geometry_source
      FROM kamchatka_routes r
     WHERE (r.slug IS NULL OR r.slug = '')
       AND r.is_visible = TRUE
       AND r.merged_into_id IS NULL
  )
  SELECT m.id_text                 AS id,
         m.title,
         m.base,
         m.empty_slug,
         m.created_at,
         m.activity_type,
         m.geometry_source,
         m.base = ANY($1::text[])  AS is_section,
         hp.id::text               AS place_holder_id,
         hp.name                   AS place_holder_name,
         hp.is_visible             AS place_holder_visible,
         hp.merged_into_id::text   AS place_holder_merged_into,
         hr.id::text               AS route_holder_id,
         hr.title                  AS route_holder_title,
         hr.is_visible             AS route_holder_visible,
         hr.merged_into_id         AS route_holder_merged_into,
         (SELECT count(*)::int FROM missing m2 WHERE m2.base = m.base) AS claimants,
         (NOT EXISTS (SELECT 1 FROM kamchatka_routes x WHERE x.slug = m.base || '-marshrut')
          AND NOT EXISTS (SELECT 1 FROM places y WHERE y.slug = m.base || '-marshrut')) AS marshrut_free,
         route_slug_candidate(m.id, m.title) AS would_assign
    FROM missing m
    LEFT JOIN places hp           ON m.base <> '' AND hp.slug = m.base
    LEFT JOIN kamchatka_routes hr ON m.base <> '' AND hr.slug = m.base
   ORDER BY m.title, m.id_text`;

/** Маршруты с адресом раздела: их карточку перекрывает страница раздела. */
export const ROUTE_SLUG_SHADOWED_SQL = `
  SELECT r.id::text AS id, r.title, r.slug
    FROM kamchatka_routes r
   WHERE r.slug = ANY($1::text[])
     AND r.is_visible = TRUE
     AND r.merged_into_id IS NULL
   ORDER BY r.slug`;

export interface RouteSlugCensusRow {
  id: string;
  title: string;
  base: string;
  empty_slug: boolean;
  created_at: Date | string | null;
  activity_type: string | null;
  geometry_source: string | null;
  is_section: boolean;
  place_holder_id: string | null;
  place_holder_name: string | null;
  place_holder_visible: boolean | null;
  place_holder_merged_into: string | null;
  route_holder_id: string | null;
  route_holder_title: string | null;
  route_holder_visible: boolean | null;
  route_holder_merged_into: string | null;
  claimants: number;
  marshrut_free: boolean;
  would_assign: string | null;
}

/**
 * Один исход на маршрут — чтобы список читался глазами:
 *  - `empty_base` — имя не даёт адреса (одни знаки);
 *  - `section` — адрес совпал бы с разделом `/routes/<раздел>`;
 *  - `*_place` — адрес держит место (видимое, скрытое или слитое) и
 *    `<имя>-marshrut` занят тоже: свободный правило 1239 выдало бы само;
 *  - `merged_into_this` — адрес держит дубль, слитый В ЭТОТ маршрут;
 *  - `merged_route` / `hidden_route` / `visible_route` — держит другой маршрут;
 *  - `namesake` — двое без адреса с одним именем: делить «кто первый» нельзя;
 *  - `free` — свободен, правило записи должно было его выдать.
 */
export type RouteSlugHolder =
  | 'empty_base'
  | 'section'
  | 'visible_place'
  | 'hidden_place'
  | 'merged_place'
  | 'merged_into_this'
  | 'merged_route'
  | 'hidden_route'
  | 'visible_route'
  | 'namesake'
  | 'free';

export function routeSlugHolder(r: RouteSlugCensusRow): RouteSlugHolder {
  if (r.base === '') return 'empty_base';
  if (r.is_section) return 'section';
  if (r.place_holder_id) {
    if (r.place_holder_merged_into) return 'merged_place';
    return r.place_holder_visible ? 'visible_place' : 'hidden_place';
  }
  if (r.route_holder_id) {
    if (r.route_holder_merged_into) {
      return r.route_holder_merged_into === r.id ? 'merged_into_this' : 'merged_route';
    }
    return r.route_holder_visible ? 'visible_route' : 'hidden_route';
  }
  if (r.claimants > 1) return 'namesake';
  return 'free';
}
