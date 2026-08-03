-- Migration 805: галерея партнёра «Камчатская Рыбалка» (реальные фото улова)
--
-- Владелец прислал 6 настоящих фото fishingkam (улов лосося на Камчатке).
-- Файлы — public/images/fishingkam/catch-01..06.jpg. Ставим их в галерею
-- партнёра (partners.gallery) и первым — в hero, если hero ещё пуст.
-- Реальные фото Камчатки, не сток (§9). Идемпотентно по результату.

UPDATE partners
   SET gallery = '[
         "/images/fishingkam/catch-01.jpg",
         "/images/fishingkam/catch-02.jpg",
         "/images/fishingkam/catch-03.jpg",
         "/images/fishingkam/catch-04.jpg",
         "/images/fishingkam/catch-05.jpg",
         "/images/fishingkam/catch-06.jpg"
       ]'::jsonb,
       hero_image = COALESCE(NULLIF(hero_image, ''), '/images/fishingkam/catch-01.jpg')
 WHERE slug IN ('fishingkam', 'kamchatskaya-rybalka', 'rybalka-po-kamchatski')
    OR name ILIKE '%камчатская рыбалка%'
    OR name ILIKE '%рыбалка по-камчатски%';
