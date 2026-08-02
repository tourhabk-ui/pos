-- Migration 795: галерея сплава по Быстрой — живые фото рыбалки, медведей, икры
--
-- Оператор прислал ещё кадры выезда: рыбалка на реке с видом на вулканы, бурый
-- медведь у воды (реальное подтверждение «фотоохоты на медведя»), голец в руках,
-- красная икра на берегу. 794 поставила первые 4 фото; здесь расширяем галерею
-- до 8 отобранных (кадр 08 с медведем-размытый в витрину не берём — качество).
--
-- Порядок галереи ведёт историю: обложка (река+вулканы) → рыбалка → медведь →
-- улов → икра → сплав → лосось → уха. tour_image (обложка) не трогаем.
-- Файлы — в public/images/tours/bystraya-rafting/, не внешние ссылки.
--
-- Идемпотентна: обновляем, только если в галерее ещё нет новых кадров.

UPDATE operator_tours t
   SET photos = ARRAY[
         '/images/tours/bystraya-rafting/01-river-volcanoes.jpg',
         '/images/tours/bystraya-rafting/06-fishing-group.jpg',
         '/images/tours/bystraya-rafting/07-bear-river.jpg',
         '/images/tours/bystraya-rafting/05-char-catch.jpg',
         '/images/tours/bystraya-rafting/09-caviar.jpg',
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
   AND NOT (t.photos @> ARRAY['/images/tours/bystraya-rafting/07-bear-river.jpg']);
