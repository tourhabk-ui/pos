-- Migration 804: логотип партнёра «Камчатская Рыбалка» (fishingkam.ru)
--
-- Владелец прислал лого (медведь + два лосося, «KAMCHATKA FISHING»). Файл —
-- public/images/fishingkam/logo.png. Ставим его в partners.logo_image, чтобы
-- он показался на странице оператора (у слуга fishingkam / kamchatskaya-rybalka).
-- Матчим по слугам и по названию (на всякий случай), идемпотентно.

UPDATE partners
   SET logo_image = '/images/fishingkam/logo.png'
 WHERE (
        slug IN ('fishingkam', 'kamchatskaya-rybalka', 'rybalka-po-kamchatski')
     OR name ILIKE '%камчатская рыбалка%'
     OR name ILIKE '%рыбалка по-камчатски%'
   )
   AND logo_image IS DISTINCT FROM '/images/fishingkam/logo.png';
