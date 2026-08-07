-- 835: Турам «Камчатской рыбалки» — их настоящие фото вместо чужих.
--
-- Источник: владелец, 07.08.2026 — «фейковые фото туров, это не фото от
-- Камчатской рыбалки». История: галереи назначали миграции 085/086 (март),
-- но photos тогда была jsonb, и присваивание ARRAY[...] падало — на проде
-- остались снимки биржевого скрейпера (чужие). Файлы /images/fishingkam/* —
-- скрейп СОБСТВЕННОГО сайта партнёра fishingkam.ru, проверены глазами
-- (рыбак с микижей, улов на берегу). После 827 photos — TEXT[], маппинг
-- из 086 наконец может доехать. tour_image ставим явно: главная берёт
-- COALESCE(tour_image, photos[1]).
--
-- Ограничение по владельцу туров: не трогаем id, если они больше не
-- принадлежат «Камчатской рыбалке». Идемпотентно.

WITH kf AS (
  SELECT id FROM partners WHERE name ILIKE 'камчатская рыбалка' LIMIT 1
)
UPDATE operator_tours ot SET
  photos = m.photos,
  tour_image = m.photos[1],
  updated_at = NOW()
FROM (VALUES
  (4,  ARRAY['/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/_.jpeg']),
  (5,  ARRAY['/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/_.jpeg','/images/fishingkam/2025-01-09_114531_1.jpg']),
  (6,  ARRAY['/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/_.jpeg']),
  (7,  ARRAY['/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/_.jpeg']),
  (9,  ARRAY['/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/_.jpeg','/images/fishingkam/2025-02-10_151441.jpg','/images/fishingkam/2025-02-10_151450.jpg']),
  (10, ARRAY['/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/2025-02-10_151433.jpg','/images/fishingkam/2025-02-10_151450.jpg']),
  (11, ARRAY['/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/2025-02-10_151441.jpg','/images/fishingkam/2025-02-10_151433.jpg'])
) AS m(id, photos)
WHERE ot.id = m.id
  AND ot.deleted_at IS NULL
  AND ot.operator_id = (SELECT id FROM kf);
