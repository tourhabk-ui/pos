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

/**
 * Живое место: видимое и не слитое. Одно условие на «рядом» и на «ближайшее»:
 * ссылка на слитое место — заведомо мёртвая, а скрытая запись — не место для
 * туриста. Псевдоним таблицы — `p`.
 */
const LIVE_PLACE_SQL = `p.is_visible = true
    AND p.merged_into_id IS NULL`;

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
    AND ${LIVE_PLACE_SQL}
    AND p.lat BETWEEN ($1::float - 0.5) AND ($1::float + 0.5)
    AND p.lng BETWEEN ($2::float - 0.8) AND ($2::float + 0.8)
  -- Ровное расстояние — по ark_id: иначе порядок равных менялся бы от запроса к запросу.
  ORDER BY d.km, p.ark_id
  LIMIT ${NEARBY_LIMIT}`;

/**
 * Ближайшее место к точке человека — для «Анализатора безопасности»
 * (/tools/safety, кнопка GPS; 14.11).
 *
 * До 14.11 инструмент брал ближайшее место по сумме квадратов разниц в
 * градусах (та же ошибка, что описана выше), без предела расстояния и без
 * отбора видимых: за сто километров от любого места человек получал оценку
 * чужого места, расстояние ему не называлось, а ближайшей могла оказаться
 * скрытая или слитая запись.
 *
 * Здесь — настоящее расстояние и только живые места. Рамки нет намеренно:
 * ближайшее место нужно назвать и тогда, когда оно далеко («ближайшее — в
 * 140 км»), а мест в базе сотни — сортировка всех недорога.
 *
 * $1 — широта точки, $2 — долгота.
 */
export const NEAREST_PLACE_SQL = `
  SELECT
    p.ark_id::text AS id,
    p.slug,
    p.name,
    p.location_type,
    d.km::float AS km
  FROM places p
  CROSS JOIN LATERAL (
    SELECT 6371 * acos(
      LEAST(1.0, cos(radians($1::float)) * cos(radians(p.lat::float)) *
        cos(radians(p.lng::float) - radians($2::float)) +
        sin(radians($1::float)) * sin(radians(p.lat::float)))
    ) AS km
  ) d
  WHERE ${LIVE_PLACE_SQL}
    AND p.lat IS NOT NULL
    AND p.lng IS NOT NULL
  ORDER BY d.km, p.ark_id
  LIMIT 1`;

// Предел «это там, где вы стоите» — в lib/places/nearest-limit: его читает и экран,
// а этому модулю (SQL, origin снимков) в клиентском коде делать нечего.
export { NEAREST_PLACE_MAX_KM } from '@/lib/places/nearest-limit';
