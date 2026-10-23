-- 1319: фото «Лагуны Прокат» — обложка и галерея партнёра, снимок у каждой машины проката.
--
-- Владелец 23.10: «бери фото автомобилей». Снимки — с сайта прокатчика
-- (https://лагунапрокат.рф/, страницы rent/suzuki, rent/tank300, rent/sever):
-- его собственные кадры парка (Tank-300 с номерами региона 41, Suzuki Jimny у
-- его гаража, Sever Truck на снегу, Ford Transit с надписью «Лагуна», «Урал»).
-- Стоковый баннер Jimny и крупный план фары Tank с сайта не взяты: это не
-- их машины. Подпись у каждого кадра — «Лагуна Прокат».
--
-- Файлы — public/images/laguna-prokat/ (пережаты до 1600 px по длинной
-- стороне, EXIF снят), варианты WebP нарезаны scripts/optimize-images.mjs и
-- записаны в lib/images/photo-variants.json.
--
-- Новая колонка car_rental_offers.photo_url — снимок конкретной машины для
-- строки прайса на витрине и странице прокатчика; NULL — снимка нет, и строка
-- показывается без него. Обложка и галерея партнёра общие для страницы
-- перевозчика (/transfers/laguna-prokat) и прокатчика (/car-rental/laguna-prokat).
--
-- Пишется только в пустое: что положил администратор, не перетирается.

BEGIN;

ALTER TABLE car_rental_offers ADD COLUMN IF NOT EXISTS photo_url TEXT;
COMMENT ON COLUMN car_rental_offers.photo_url IS
  'Снимок машины для строки прайса: путь /images/… или адрес; NULL — снимка нет (1319)';

UPDATE partners
   SET hero_image = '/images/laguna-prokat/laguna-fleet-tank300.jpg',
       gallery = jsonb_build_array(
         '/images/laguna-prokat/laguna-ford-transit.jpg',
         '/images/laguna-prokat/laguna-ural-vahtovka.jpg',
         '/images/laguna-prokat/laguna-tank300-row.jpg',
         '/images/laguna-prokat/laguna-suzuki-jimny.jpg',
         '/images/laguna-prokat/laguna-sever-truck.jpg',
         '/images/laguna-prokat/laguna-tank300-lava.jpg',
         '/images/laguna-prokat/laguna-tank300-beach.jpg',
         '/images/laguna-prokat/laguna-sever-trucks-row.jpg'
       ),
       gallery_credits = COALESCE(gallery_credits, '{}'::jsonb) || jsonb_build_object(
         '/images/laguna-prokat/laguna-fleet-tank300.jpg',    'Лагуна Прокат',
         '/images/laguna-prokat/laguna-ford-transit.jpg',     'Лагуна Прокат',
         '/images/laguna-prokat/laguna-ural-vahtovka.jpg',    'Лагуна Прокат',
         '/images/laguna-prokat/laguna-tank300-row.jpg',      'Лагуна Прокат',
         '/images/laguna-prokat/laguna-suzuki-jimny.jpg',     'Лагуна Прокат',
         '/images/laguna-prokat/laguna-sever-truck.jpg',      'Лагуна Прокат',
         '/images/laguna-prokat/laguna-tank300-lava.jpg',     'Лагуна Прокат',
         '/images/laguna-prokat/laguna-tank300-beach.jpg',    'Лагуна Прокат',
         '/images/laguna-prokat/laguna-sever-trucks-row.jpg', 'Лагуна Прокат'
       ),
       updated_at = NOW()
 WHERE slug = 'laguna-prokat'
   AND hero_image IS NULL;

UPDATE car_rental_offers o
   SET photo_url = v.photo,
       updated_at = NOW()
  FROM partners p,
       (VALUES
         ('Suzuki Jimny', '/images/laguna-prokat/laguna-suzuki-jimny.jpg'),
         ('Tank-300',     '/images/laguna-prokat/laguna-tank300-row.jpg'),
         ('Sever Truck',  '/images/laguna-prokat/laguna-sever-truck.jpg')
       ) AS v(title, photo)
 WHERE p.slug = 'laguna-prokat'
   AND o.partner_id::text = p.id::text
   AND o.title = v.title
   AND o.photo_url IS NULL;

COMMIT;
