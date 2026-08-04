-- Migration 813: вернуть галерею туру «Сплав по реке Быстрая»
--
-- Симптом: на карточке одно фото, хотя оператор прислал девять. Диагностика
-- прода показывала у тура `photos: 0` — массив пуст, и карточка честно
-- показывала единственный `tour_image`.
--
-- Как так вышло (цепочка из трёх шагов):
--   1. Миграция 795 ставила галерею, но матчила тур по ДЛИННОМУ названию
--      «Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ» — это ВТОРОЙ тур, дубль.
--      Видимому туристу туру («Сплав по реке Быстрая») она не досталась.
--   2. Миграция 806 это чинила и ставила галерею правильно — но упала целиком:
--      в ней есть INSERT INTO partners, а таблица создана до системы миграций,
--      её NOT NULL-колонки в репозитории неизвестны.
--   3. Миграция 810 подняла тур из небытия, но намеренно делала минимум —
--      оператора и видимость. Фото она не трогает.
--
-- Поэтому здесь: НИ ОДНОГО INSERT, только UPDATE по существующей строке.
-- Матч по содержанию (Быстрая + сплав/rafting), ровно один тур, идемпотентно.
--
-- Состав галереи — те же восемь отобранных кадров, что и в 795. Девятый
-- (08-bear-fish) не берём: кадр смазан, в витрину такое не ставим. Порядок
-- ведёт историю выезда: обложка (река + вулканы) → рыбалка → медведь → улов →
-- икра → сплав → лосось → уха на берегу.
-- Файлы лежат в public/images/tours/bystraya-rafting/ и уже в git.

WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.deleted_at IS NULL
     AND ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE WHEN ot.title = 'Сплав по реке Быстрая' THEN 0 ELSE 1 END,
     ot.created_at ASC
   LIMIT 1
)
UPDATE operator_tours ot
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
       -- Обложку ставим, только если её нет: сейчас она заполнена и работает.
       tour_image = COALESCE(NULLIF(ot.tour_image, ''), '/images/tours/bystraya-rafting/01-river-volcanoes.jpg'),
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND COALESCE(array_length(ot.photos, 1), 0) < 8;
