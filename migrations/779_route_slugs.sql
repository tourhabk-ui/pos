-- 779_route_slugs.sql
-- ЧПУ-слаги для карточек /routes/[id]: человекочитаемый URL вместо UUID
-- (SEO — поисковикам понятнее `vulkan-gorely`, чем непрозрачный UUID).
--
-- /routes/[id] резолвит и places, и kamchatka_routes (через VIEW
-- agent_route_knowledge), поэтому slug обязан быть УНИКАЛЕН ГЛОБАЛЬНО между
-- обеими таблицами — иначе один URL укажет на две сущности. Бэкфилл строит
-- слаги разом по объединению и добавляет числовой суффикс на коллизиях.
--
-- Транслитерация зеркалит lib/text/slugify.ts (та же карта), чтобы новые строки
-- из приложения и бэкфилл давали одинаковый результат. Идемпотентно: колонки
-- через IF NOT EXISTS, бэкфилл только там, где slug ещё NULL.

-- 1. Детерминированная транслитерация RU→latin (как в lib/text/slugify.ts)
CREATE OR REPLACE FUNCTION translit_ru_slug(txt TEXT) RETURNS TEXT AS $$
DECLARE v TEXT;
BEGIN
  v := lower(coalesce(txt, ''));
  -- многобуквенные сначала (translate умеет только 1→1)
  v := replace(v, 'ё', 'yo');
  v := replace(v, 'ж', 'zh');
  v := replace(v, 'ц', 'ts');
  v := replace(v, 'ч', 'ch');
  v := replace(v, 'ш', 'sh');
  v := replace(v, 'щ', 'shch');
  v := replace(v, 'ю', 'yu');
  v := replace(v, 'я', 'ya');
  -- однобуквенные 1→1
  v := translate(v, 'абвгдезийклмнопрстуфхыэ', 'abvgdezijklmnoprstufhye');
  -- немые знаки
  v := replace(v, 'ъ', '');
  v := replace(v, 'ь', '');
  -- всё не [a-z0-9] → дефис, схлопнуть, обрезать
  v := regexp_replace(v, '[^a-z0-9]+', '-', 'g');
  v := regexp_replace(v, '^-+|-+$', '', 'g');
  v := left(v, 80);
  v := regexp_replace(v, '-+$', '', 'g');
  RETURN v;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 2. Колонки
ALTER TABLE places            ADD COLUMN IF NOT EXISTS slug VARCHAR(80);
ALTER TABLE kamchatka_routes  ADD COLUMN IF NOT EXISTS slug VARCHAR(80);

-- 3. Бэкфилл с глобальной дедупликацией (только там, где slug ещё не задан)
WITH named AS (
  SELECT id, 'place'::text AS src, translit_ru_slug(name)  AS base
    FROM places
   WHERE slug IS NULL AND name IS NOT NULL AND translit_ru_slug(name) <> ''
  UNION ALL
  SELECT id, 'route'::text AS src, translit_ru_slug(title) AS base
    FROM kamchatka_routes
   WHERE slug IS NULL AND title IS NOT NULL AND translit_ru_slug(title) <> ''
),
-- существующие слаги — чтобы новый бэкфилл не столкнулся с уже занятыми
taken AS (
  SELECT slug FROM places           WHERE slug IS NOT NULL
  UNION
  SELECT slug FROM kamchatka_routes WHERE slug IS NOT NULL
),
ranked AS (
  SELECT id, src, base,
         ROW_NUMBER() OVER (PARTITION BY base ORDER BY src, id) AS rn
    FROM named
),
finalized AS (
  SELECT id, src,
         CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS slug
    FROM ranked
)
UPDATE places p
   SET slug = f.slug
  FROM finalized f
 WHERE f.src = 'place' AND f.id = p.id
   AND p.slug IS NULL
   AND f.slug NOT IN (SELECT slug FROM taken);

WITH named AS (
  SELECT id, 'place'::text AS src, translit_ru_slug(name)  AS base
    FROM places
   WHERE slug IS NULL AND name IS NOT NULL AND translit_ru_slug(name) <> ''
  UNION ALL
  SELECT id, 'route'::text AS src, translit_ru_slug(title) AS base
    FROM kamchatka_routes
   WHERE slug IS NULL AND title IS NOT NULL AND translit_ru_slug(title) <> ''
),
taken AS (
  SELECT slug FROM places           WHERE slug IS NOT NULL
  UNION
  SELECT slug FROM kamchatka_routes WHERE slug IS NOT NULL
),
ranked AS (
  SELECT id, src, base,
         ROW_NUMBER() OVER (PARTITION BY base ORDER BY src, id) AS rn
    FROM named
),
finalized AS (
  SELECT id, src,
         CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS slug
    FROM ranked
)
UPDATE kamchatka_routes k
   SET slug = f.slug
  FROM finalized f
 WHERE f.src = 'route' AND f.id = k.id
   AND k.slug IS NULL
   AND f.slug NOT IN (SELECT slug FROM taken);

-- 4. Уникальность внутри каждой таблицы (глобальную обеспечил бэкфилл).
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_slug            ON places(slug)           WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kamchatka_routes_slug  ON kamchatka_routes(slug) WHERE slug IS NOT NULL;
