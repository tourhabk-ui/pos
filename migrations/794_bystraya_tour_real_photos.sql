-- Migration 794: реальные фото сплава по Быстрой (из канала оператора)
--
-- Владелец прислал настоящие фото выезда: река Быстрая на фоне вулканов,
-- сам сплав (рафт, спасжилеты, снаряжение), пойманный лосось и уха с красной
-- икрой на берегу. До этого карточка показывала generic-заглушку
-- /images/activities/rafting.jpg (fallback по activity_type в MarketplaceClient)
-- — не этот тур, а абстрактный сплав. Теперь у тура своё лицо.
--
-- Файлы лежат в public/images/tours/bystraya-rafting/ (оптимизированы, без
-- эмодзи в путях). tour_image — обложка карточки в каталоге; photos[] —
-- галерея на странице тура (app/marketplace/tours/[id] берёт photos, иначе
-- откатывается на [tour_image]). Первым в галерее и обложкой — река с
-- вулканами: самый сильный кадр и это буквально то место, где идёт сплав.
--
-- Порядок галереи: пейзаж → сам сплав → улов → обед на берегу (от вида к
-- действию и результату). Пути — из public/, не внешние ссылки (правило репо).
--
-- Идемпотентна: обновляем только если обложка ещё не указывает на эти фото.

UPDATE operator_tours t
   SET tour_image = '/images/tours/bystraya-rafting/01-river-volcanoes.jpg',
       photos     = ARRAY[
         '/images/tours/bystraya-rafting/01-river-volcanoes.jpg',
         '/images/tours/bystraya-rafting/02-rafting.jpg',
         '/images/tours/bystraya-rafting/03-salmon-catch.jpg',
         '/images/tours/bystraya-rafting/04-shore-lunch.jpg'
       ],
       updated_at = NOW()
  FROM partners p
 WHERE p.id = t.operator_id
   AND p.slug = 'kamchatka-rafting'
   AND t.title = 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'
   AND t.deleted_at IS NULL
   AND t.tour_image IS DISTINCT FROM '/images/tours/bystraya-rafting/01-river-volcanoes.jpg';
