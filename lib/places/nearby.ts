/**
 * «Рядом» на карточке места — ближайшие места по НАСТОЯЩЕМУ расстоянию (14.10).
 *
 * Прежний запрос отбирал места в рамке, но сортировал их по сумме квадратов
 * разниц в градусах. На широте Камчатки градус долготы короче градуса широты
 * почти вдвое (cos 53° ≈ 0,6), поэтому место в 20 км к востоку проигрывало
 * месту в 28 км к северу. Блок показывал километры гаверсинусом, а порядок —
 * по градусам: «28 км» стояло выше «20 км», а ближайшее место могло не войти в
 * шестёрку вовсе. Заодно это решало, на какие места карточка ставит ссылки:
 * перепись sitemap 14.10 нашла четыре места, на которые не ссылается ни одна
 * карточка, кроме страниц-продолжений списка.
 *
 * Теперь порядок — по тому же расстоянию, что показано человеку. Рамка
 * осталась только отбором: ±0,5° широты (~55 км) и ±0,8° долготы (~50 км на
 * этой широте).
 */
import { shownPhotoSql } from '@/lib/images/origin';

export const NEARBY_LIMIT = 6;

/** $1 — широта места, $2 — долгота, $3 — его ark_id (само место в «рядом» не входит). */
export const NEARBY_PLACES_SQL = `
  SELECT
    p.ark_id AS id,
    p.slug,
    p.name,
    p.location_type,
    p.lat,
    p.lng,
    p.photo_url,
    -- Та же метка версии у миниатюр «рядом»: адрес без неё замерзал бы
    -- на год так же, как у главного фото.
    (SELECT '/api/images/route/' || p.ark_id || '?v=' || EXTRACT(EPOCH FROM ai2.created_at)::bigint
       FROM ai_route_images ai2
      WHERE ai2.route_id = p.ark_id
        AND ${shownPhotoSql('ai2.model')}
      LIMIT 1) AS thumb_url,
    round(d.km)::int AS distance_km
  FROM places p
  CROSS JOIN LATERAL (
    SELECT 6371 * acos(
      LEAST(1.0, cos(radians($1::float)) * cos(radians(p.lat::float)) *
        cos(radians(p.lng::float) - radians($2::float)) +
        sin(radians($1::float)) * sin(radians(p.lat::float)))
    ) AS km
  ) d
  WHERE p.ark_id != $3
    AND p.is_visible = true
    -- «Рядом» со ссылкой на слитое место — заведомо мёртвая ссылка.
    AND p.merged_into_id IS NULL
    AND p.lat BETWEEN ($1::float - 0.5) AND ($1::float + 0.5)
    AND p.lng BETWEEN ($2::float - 0.8) AND ($2::float + 0.8)
  -- Ровное расстояние — по ark_id: иначе порядок равных менялся бы от запроса к запросу.
  ORDER BY d.km, p.ark_id
  LIMIT ${NEARBY_LIMIT}`;
