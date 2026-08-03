-- Migration 806: свести тур «Сплав по реке Быстрая» к ОДНОЙ честной карточке
--
-- Симптомы на проде (карточка /catalog/tours/27, скриншоты владельца):
--   1. Оператор показан как «Рога и Копыта» — демо-заглушка. Реальный оператор —
--      «Камчатка Рафтинг» (slug kamchatka-rafting, контакты Катерина + Ярослав,
--      создан миграцией 060).
--   2. Всего одно фото — галереи нет. У тура пустой photos[], хотя 9 реальных
--      кадров лежат в public/images/tours/bystraya-rafting/ (в git).
--   3. Дубль в каталоге.
--
-- Корень: миграции 795 (галерея) и 796 (состав) МАТЧИЛИ строго по названию
-- 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ' И slug kamchatka-rafting — это
-- ВТОРОЙ тур (его создала 800). А видимый туристу тур (id 27, короткое имя
-- «Сплав по реке Быстрая», привязан к «Рога и Копыта») под этот матч не попал:
-- ему достались только честное описание (802 матчит по содержанию) — и всё.
-- Получилось два тура: обогащённый-невидимый и голый-видимый.
--
-- Эта миграция матчит КАНОНИЧЕСКИЙ тур ПО СОДЕРЖАНИЮ (Быстрая + сплав/rafting),
-- а не по хрупкому названию, приводит его к правильному оператору + галерее +
-- составу, нормализует имя к «Сплав по реке Быстрая», и гасит остальные дубли
-- сплава по Быстрой без броней. Самодостаточна, идемпотентна, от id не зависит.

-- 1. Гарантируем реального оператора (на случай чистого окружения) — из 060.
INSERT INTO partners (slug, name, contacts, location, is_public, created_at)
VALUES (
  'kamchatka-rafting',
  'Камчатка Рафтинг',
  jsonb_build_object(
    'phone', '+79247990191',
    'admin_name', 'Катерина',
    'admin_name_2', 'Ярослав',
    'telegram_channel', 'https://t.me/+GCy5EVOotCE1NDMy'
  ),
  jsonb_build_object('city', 'Петропавловск-Камчатский', 'region', 'Камчатский край'),
  TRUE, NOW()
)
ON CONFLICT (slug) DO NOTHING;

-- 2. Выбираем ОДИН канонический тур сплава по Быстрой (по содержанию).
--    Приоритет: короткое имя «Сплав по реке Быстрая» (тот, что видит турист) →
--    длинное имя из 800 → любой подходящий. Дальше — старейший (стабильно).
WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.deleted_at IS NULL
     AND ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE
       WHEN ot.title ILIKE 'Сплав по реке Быстрая%' THEN 0
       WHEN ot.title ILIKE 'Однодневная экскурсия%'  THEN 1
       ELSE 2
     END,
     ot.created_at ASC
   LIMIT 1
),
op AS (
  SELECT id FROM partners WHERE slug = 'kamchatka-rafting'
)
-- 3. Приводим канонический тур к правильному виду: реальный оператор, категория,
--    публикация, честное имя, галерея, обложка, состав. Фото и состав — те же,
--    что 795/796 давали второму туру (подтверждённый контент оператора).
UPDATE operator_tours ot
   SET operator_id  = op.id,
       activity_type = 'rafting',
       is_active    = TRUE,
       is_published = TRUE,
       deleted_at   = NULL,
       title        = 'Сплав по реке Быстрая',
       tour_image   = COALESCE(NULLIF(ot.tour_image, ''), '/images/tours/bystraya-rafting/01-river-volcanoes.jpg'),
       photos = ARRAY[
         '/images/tours/bystraya-rafting/01-river-volcanoes.jpg',
         '/images/tours/bystraya-rafting/06-fishing-group.jpg',
         '/images/tours/bystraya-rafting/07-bear-river.jpg',
         '/images/tours/bystraya-rafting/05-char-catch.jpg',
         '/images/tours/bystraya-rafting/09-caviar.jpg',
         '/images/tours/bystraya-rafting/02-rafting.jpg',
         '/images/tours/bystraya-rafting/03-salmon-catch.jpg',
         '/images/tours/bystraya-rafting/04-shore-lunch.jpg'
       ],
       short_description = 'Однодневный сплав по реке Быстрой с ухой из лосося, рыбалкой, фотоохотой на бурого медведя и купанием в Малкинских термальных источниках.',
       included = ARRAY[
         'Трансфер туда и обратно',
         'Питание: уха из лосося, нарезки, чай, кофе',
         'Услуги гида и повара',
         'Удочки и снасти для рыбалки',
         'Снаряжение и экипировка для сплава'
       ],
       not_included = ARRAY[
         'Перекус в посёлке Сокочи (пирожки, самооплата)',
         'Личные расходы',
         'Купальные принадлежности (взять с собой)'
       ],
       what_to_bring = ARRAY[
         'Купальник или плавки, полотенце',
         'Сменная одежда и запасные носки',
         'Тёплая кофта или флиска',
         'Ветровка или дождевик',
         'Обувь, которая может намокнуть',
         'Головной убор, очки, солнцезащитный крем',
         'Репеллент от комаров и мошки',
         'Наличные, вода, powerbank',
         'Личные лекарства; гермомешок для телефона'
       ],
       updated_at = NOW()
  FROM canonical c, op
 WHERE ot.id = c.id;

-- 4. Гасим ОСТАЛЬНЫЕ дубли сплава по Быстрой (кроме канонического), но только
--    без броней — иначе не осиротить. Мягкое удаление, данные не теряем.
UPDATE operator_tours dup
   SET deleted_at   = NOW(),
       is_published = FALSE,
       is_active    = FALSE,
       updated_at   = NOW()
 WHERE dup.deleted_at IS NULL
   AND dup.title ILIKE '%быстр%'
   AND (dup.title ILIKE '%сплав%' OR dup.activity_type IN ('rafting', 'boat_trip'))
   AND dup.id <> (
     SELECT ot.id
       FROM operator_tours ot
      WHERE ot.deleted_at IS NULL
        AND ot.title = 'Сплав по реке Быстрая'
      ORDER BY ot.created_at ASC
      LIMIT 1
   )
   AND NOT EXISTS (
     SELECT 1 FROM operator_bookings b WHERE b.operator_tour_id = dup.id
   );
