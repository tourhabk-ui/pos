-- 787: пересборка v_kamchatka_routes_api по фактам, а не по надежде.
--
-- Две миграции падали при каждом деплое, и обе — про это представление:
--   670 — «cannot change name of view column "route_id" to "id"»:
--         CREATE OR REPLACE VIEW не умеет переименовывать колонки;
--   738 — «cannot drop view because other objects depend on it», хотя её
--         собственный комментарий утверждал, что зависимых нет.
--
-- Аудит боевой схемы дал недостающее. Живое определение:
--
--   SELECT id AS route_id, dedupe_key AS route_dedupe_key, category, title,
--          description, lat, lng, source_url, source_name,
--          COALESCE(metadata->>'import_source', source_name, 'unknown') AS import_source,
--          lat IS NOT NULL AND lng IS NOT NULL AS has_coordinates,
--          count(*) OVER (PARTITION BY category) AS category_total,
--          row_number() OVER (PARTITION BY category ORDER BY title, dedupe_key) AS category_position,
--          metadata, created_at, updated_at AS source_updated_at
--     FROM kamchatka_routes kr;
--
-- Отсюда три вывода.
--
-- ПЕРВЫЙ, и он важнее починки: WHERE тут НЕТ. Представление не скрывает
-- is_visible = false. Правило CLAUDE.md «читать маршруты только через
-- v_kamchatka_routes_api, чтобы наружу не попадали скрытые» опирается на
-- свойство, которого у представления не было. Новая версия фильтр вводит —
-- то есть начинает делать то, что от неё все и ждали.
--
-- ВТОРОЙ: в представлении нет ни id, ни geometry, ни mchs_phone, ни
-- is_visible. Поэтому семь потребителей падали при каждом вызове (#872), среди
-- них покрытие МЧС, офлайн-пакет маршрута и предполётная проверка гида.
--
-- ТРЕТИЙ: зависимый объект ровно один — v_kamchatka_route_groups_api, агрегат
-- по категориям. Кодом он не используется нигде и не объявлен ни одной
-- миграцией репозитория: существует только в проде. Здесь он пересоздаётся
-- дословно, с теми же именами колонок, чтобы возможный внешний потребитель
-- (аналитика, BI) не остался без него. Его числа изменятся: скрытые маршруты
-- перестанут попадать в подсчёт — это следствие фильтра, названное явно.
--
-- Идемпотентна: DROP ... IF EXISTS + CREATE. Порядок важен — сначала зависимый.

BEGIN;

DROP VIEW IF EXISTS v_kamchatka_route_groups_api;
DROP VIEW IF EXISTS v_kamchatka_routes_api;

-- Надмножество: колонки, которых ждал код (id, geometry, mchs_*, safety-поля),
-- плюс те, на которых держится агрегат ниже (category, has_coordinates,
-- source_updated_at) и прежние вычисляемые (import_source, category_*).
CREATE VIEW v_kamchatka_routes_api AS
SELECT
  id,
  ark_id,
  slug,
  dedupe_key                AS route_dedupe_key,
  title,
  description,
  category,
  activity_type,
  zone,
  lat,
  lng,
  lat IS NOT NULL AND lng IS NOT NULL AS has_coordinates,
  source_url,
  source_name,
  COALESCE(metadata ->> 'import_source', source_name, 'unknown') AS import_source,
  difficulty,
  distance_km,
  duration_hours,
  duration_days,
  elevation_gain_m,
  season,
  route_type,
  geometry,
  hazards,
  equipment,
  mchs_registration_required,
  mchs_phone,
  park_name,
  park_approval_url,
  flora_fauna,
  accessibility,
  is_visible,
  view_count,
  metadata,
  count(*)      OVER (PARTITION BY category)                                AS category_total,
  row_number()  OVER (PARTITION BY category ORDER BY title, dedupe_key)     AS category_position,
  created_at,
  updated_at,
  updated_at                AS source_updated_at
FROM kamchatka_routes
WHERE is_visible = TRUE OR is_visible IS NULL;

-- Дословно как было на проде, поверх нового представления.
CREATE VIEW v_kamchatka_route_groups_api AS
SELECT
  category,
  count(*)::integer                                   AS total_routes,
  count(*) FILTER (WHERE has_coordinates)::integer     AS total_with_coordinates,
  min(source_updated_at)                              AS min_source_updated_at,
  max(source_updated_at)                              AS max_source_updated_at
FROM v_kamchatka_routes_api
GROUP BY category
ORDER BY category;

COMMIT;
