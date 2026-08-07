-- 836: Турам «Камчатской рыбалки» — РАЗНЫЕ галереи из проверенных фото.
--
-- Источник: владелец, 07.08.2026 — «на всех карточках одни и те же фото».
-- Мартовский маппинг (085/086, донесён 835-й) гонял 5 файлов по кругу на
-- всех турах, и среди них были ЧУЖИЕ кадры: серия 2025-02-10 снята у другого
-- оператора (на здании базы вывеска «SEDOVV TOUR») — скрейпер нахватал из
-- второго источника. Владелец прав: «это не фото от Камчатской рыбалки».
--
-- Каждое фото из списка ниже просмотрено глазами (07.08): рыбак с микижей в
-- лодке, медведь на берегу, закатный улов, трофейные чавычи, джип-заброска,
-- икра, улов с собакой — всё со съёмок партнёра (fishingkam.ru). Исключены:
-- серия 2025-02-10 (чужая), зимняя серия 2025-01-27 (зимних туров нет),
-- PNG-вырезки и кусты (дизайн-элементы Тильды), баннер с логотипом.
--
-- У каждого тура своя обложка — семь карточек больше не близнецы.

WITH kf AS (
  SELECT id FROM partners WHERE name ILIKE 'камчатская рыбалка' LIMIT 1
)
UPDATE operator_tours ot SET
  photos = m.photos,
  tour_image = m.photos[1],
  updated_at = NOW()
FROM (VALUES
  -- 4: Осенняя — закатный улов, осенние тона
  (4,  ARRAY['/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/catch-05.jpg']),
  -- 5: Чавыча и нерка — трофейные чавычи
  (5,  ARRAY['/images/fishingkam/catch-02.jpg','/images/fishingkam/catch-04.jpg','/images/fishingkam/catch-01.jpg','/images/fishingkam/2025-01-09_114531_1.jpg']),
  -- 6: Кижуч — серебристый кижуч в руках
  (6,  ARRAY['/images/fishingkam/__.jpeg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/catch-01.jpg','/images/fishingkam/2025-01-09_113928_1_.jpg']),
  -- 7: Семейный день — улов с собакой, медведь
  (7,  ARRAY['/images/fishingkam/catch-01.jpg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/_.jpeg','/images/fishingkam/__.jpeg']),
  -- 9: Многодневный 5 дн — лодка на реке
  (9,  ARRAY['/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/2025-01-09_114821_1.jpg','/images/fishingkam/catch-02.jpg','/images/fishingkam/catch-05.jpg']),
  -- 10: Семейный недельный — медведь на берегу
  (10, ARRAY['/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/catch-01.jpg','/images/fishingkam/2025-01-09_113928_1_.jpg','/images/fishingkam/_.jpeg']),
  -- 11: Недельный 7 дн — джип-заброска в берёзах
  (11, ARRAY['/images/fishingkam/_.jpeg','/images/fishingkam/2025-01-09_114531_1.jpg','/images/fishingkam/__.jpeg','/images/fishingkam/catch-04.jpg'])
) AS m(id, photos)
WHERE ot.id = m.id
  AND ot.deleted_at IS NULL
  AND ot.operator_id = (SELECT id FROM kf);
