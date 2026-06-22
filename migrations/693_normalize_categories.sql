-- Migration 693: Нормализация категорий — Russian transliteration → English slugs
-- Created: 2026-06-22
--
-- Проблема: категории вводились в разное время разными источниками без единого стандарта.
-- Результат: дубли (vulkani/volcano, ozera/lake, termalnye_istochniki/istochniki/thermal),
--            русский транслит вместо английских slug'ов.
--
-- Решение: единый маппинг для places.category и kamchatka_routes.category.

BEGIN;

-- ── Маппинг для places.category ───────────────────────────────────────────────
UPDATE places
SET category = CASE category
  -- Вулканы
  WHEN 'vulkani'              THEN 'volcano'
  -- Термальные источники (все варианты → hot_spring)
  WHEN 'termalnye_istochniki' THEN 'hot_spring'
  WHEN 'istochniki'           THEN 'hot_spring'
  WHEN 'thermal'              THEN 'hot_spring'
  -- Озёра
  WHEN 'ozera'                THEN 'lake'
  WHEN 'lakes'                THEN 'lake'
  -- Гейзеры
  WHEN 'geyzery'              THEN 'geyser'
  -- Горы
  WHEN 'mountains'            THEN 'mountain'
  -- Реки
  WHEN 'rivers'               THEN 'river'
  -- Экскурсии
  WHEN 'ekskursii'            THEN 'excursion'
  -- Морские прогулки
  WHEN 'morskie_progulki'     THEN 'sea_cruise'
  -- Пешие маршруты
  WHEN 'peshie'               THEN 'trekking'
  -- Водопады
  WHEN 'vodopady'             THEN 'waterfall'
  -- Рыбалка
  WHEN 'rybalka'              THEN 'fishing'
  -- Медведи / наблюдение за животными
  WHEN 'medvedi'              THEN 'wildlife'
  -- Пляжи
  WHEN 'plyazhi'              THEN 'beach'
  -- Вертолётные туры
  WHEN 'vertoletnye_tury'     THEN 'helicopter'
  -- Снегоход
  WHEN 'snegohod'             THEN 'snowmobile'
  -- Зима
  WHEN 'zima'                 THEN 'winter'
  -- Вода / водные активности
  WHEN 'voda'                 THEN 'water'
  ELSE category
END
WHERE category IN (
  'vulkani','termalnye_istochniki','istochniki','thermal',
  'ozera','lakes','geyzery','mountains','rivers',
  'ekskursii','morskie_progulki','peshie','vodopady',
  'rybalka','medvedi','plyazhi','vertoletnye_tury',
  'snegohod','zima','voda'
);

-- ── Маппинг для kamchatka_routes.category ────────────────────────────────────
UPDATE kamchatka_routes
SET category = CASE category
  WHEN 'vulkani'              THEN 'volcano'
  WHEN 'termalnye_istochniki' THEN 'hot_spring'
  WHEN 'istochniki'           THEN 'hot_spring'
  WHEN 'thermal'              THEN 'hot_spring'
  WHEN 'ozera'                THEN 'lake'
  WHEN 'lakes'                THEN 'lake'
  WHEN 'geyzery'              THEN 'geyser'
  WHEN 'mountains'            THEN 'mountain'
  WHEN 'rivers'               THEN 'river'
  WHEN 'ekskursii'            THEN 'excursion'
  WHEN 'morskie_progulki'     THEN 'sea_cruise'
  WHEN 'peshie'               THEN 'trekking'
  WHEN 'vodopady'             THEN 'waterfall'
  WHEN 'rybalka'              THEN 'fishing'
  WHEN 'medvedi'              THEN 'wildlife'
  WHEN 'plyazhi'              THEN 'beach'
  WHEN 'vertoletnye_tury'     THEN 'helicopter'
  WHEN 'snegohod'             THEN 'snowmobile'
  WHEN 'zima'                 THEN 'winter'
  WHEN 'voda'                 THEN 'water'
  ELSE category
END
WHERE category IN (
  'vulkani','termalnye_istochniki','istochniki','thermal',
  'ozera','lakes','geyzery','mountains','rivers',
  'ekskursii','morskie_progulki','peshie','vodopady',
  'rybalka','medvedi','plyazhi','vertoletnye_tury',
  'snegohod','zima','voda'
);

COMMIT;

-- Rollback: нет смысла откатывать (данные были некорректны изначально).
-- Если нужно — восстановить из бэкапа.
