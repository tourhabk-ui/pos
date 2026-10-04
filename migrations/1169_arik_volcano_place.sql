-- 1169: «Вулкан Арик» — новое место.
-- Created: 2026-10-04
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- 04.10 владелец прислал снимок карточки вулкана Арик из карт на данных OSM
-- (MAPS.ME): «Вулкан · 2166 m», 53.370266, 158.674797 — «и вулкан Арик». В
-- справочнике платформы его нет: MCP get_place_info по «Арик» и «вулкан Арик»
-- отвечает «места нет в справочнике». Имя Арика при этом в коде уже есть —
-- матрица разрешений парков (lib/parks/permit-matrix.ts) относит его к
-- Налычеву, — а самой точки не было.
--
-- ── Откуда координата и высота ────────────────────────────────────────────
--
-- Объект OSM, показанный владельцем в приложении (MAPS.ME): точка
-- 53.370266 / 158.674797, высота 2166 м. Тот же род источника, что у правок
-- 03.10 (Гора Замок) и 1168. coord_source = 'external'.
--
-- ── Что в описании ────────────────────────────────────────────────────────
--
-- Только то, что подтверждено: род, высота из того же объекта OSM и парк по
-- матрице разрешений платформы. Ни возраста, ни извержений, ни маршрутов —
-- источника на них здесь нет, а пустая строка лучше придуманной (§4.0).
--
-- ПОСЛЕ ВЫКАТА: полевая карта читает статичные пакеты мест — нужен перезалив
-- map-places-build (upload:true), иначе точки на телефоне не будет.
--
-- IDEMPOTENT

BEGIN;

INSERT INTO places (id, name, ark_id, lat, lng, location_type,
                    is_visible, description, coord_source, coord_source_at,
                    source_name, created_at, updated_at)
SELECT '97cfb6c3-703b-4d29-acf5-2eed3901a078',
       'Вулкан Арик',
       '73a3d225-7204-4bf0-a216-f40331301bd7',
       53.370266, 158.674797,
       'volcano',
       TRUE,
       'Арик — вулкан на территории природного парка «Налычево», высота — 2166 м. '
       || 'Координата и высота — по данным OpenStreetMap.',
       'external', NOW(),
       'OpenStreetMap',
       NOW(), NOW()
 WHERE NOT EXISTS (
         SELECT 1 FROM places q
          WHERE q.id::text <> '97cfb6c3-703b-4d29-acf5-2eed3901a078'
            AND q.merged_into_id IS NULL
            AND q.is_visible
            AND q.name ~* '(^|[^а-яё])арик([^а-яё]|$)'
       )
ON CONFLICT (id) DO NOTHING;

-- Адрес карточки: /places/vulkan-arik, если такой slug свободен.
UPDATE places p
   SET slug = translit_ru_slug(p.name)
 WHERE p.id::text = '97cfb6c3-703b-4d29-acf5-2eed3901a078'
   AND p.slug IS NULL
   AND NOT EXISTS (SELECT 1 FROM places x WHERE x.slug = translit_ru_slug(p.name))
   AND NOT EXISTS (SELECT 1 FROM kamchatka_routes r WHERE r.slug = translit_ru_slug(p.name));

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_live boolean;
  v_slug text;
BEGIN
  SELECT is_visible, slug INTO v_live, v_slug FROM places WHERE id::text = '97cfb6c3-703b-4d29-acf5-2eed3901a078';
  IF v_live IS NULL THEN
    RAISE WARNING '[1169] «Вулкан Арик» не заведён — живое место с этим именем уже есть?';
  ELSIF v_slug IS NULL THEN
    RAISE WARNING '[1169] «Вулкан Арик» заведён без slug — адрес занят, карточка откроется по id';
  END IF;
END $$;

COMMIT;
