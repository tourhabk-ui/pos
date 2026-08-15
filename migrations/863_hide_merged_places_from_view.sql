-- 863_hide_merged_places_from_view.sql
--
-- Слитые места исчезают с витрины — фильтр merged_into_id в VIEW.
--
-- ── Дыра ────────────────────────────────────────────────────────────────────
--
-- «Мягкое слияние» (/api/cron/places-dedup, миграция 737) ставит дублю
-- merged_into_id и НЕ трогает is_visible. Каталог же фильтрует только
-- is_visible (lib/routes/catalog-query.ts), а VIEW agent_route_knowledge
-- отдаёт места вовсе без оглядки на merged_into_id. Итог проверен пробами
-- 40-41 (15.08): «Гора Шишель» и «Природный парк «Налычево»» слиты ещё
-- вчерашними пробами 82-96, дедуп на повторную попытку честно отвечает
-- «уже слито» — а на карте и в каталоге обе записи стоят как ни в чём не
-- бывало. Слияние прятало запись от админки, но не от туриста.
--
-- ── Починка ─────────────────────────────────────────────────────────────────
--
-- Фильтр ставится в VIEW, а не в каталог: через agent_route_knowledge читают
-- каталог, карта, поиск и retrieval Кузьмича — чинить каждого потребителя
-- по отдельности значит забыть одного. Текст VIEW — точная копия миграции 711
-- (последняя редакция, с embedding) плюс ОДНО условие в ветке places.
-- Ветка маршрутов не меняется: у kamchatka_routes слияний нет.
--
-- INSTEAD OF триггеры (663/677/711) переживают CREATE OR REPLACE VIEW.
-- Урок миграции 850 учтён: скрываются только записи, слитые В ДРУГИЕ
-- (merged_into_id IS NOT NULL), оставленные не трогаются.
--
-- Заодно — добор парка «Налычево» после слияния дублей: выжившей записи,
-- какая бы из двух ни осталась главной, ставятся верифицированные координаты
-- парка (Wikipedia «Налычево»: 53.5, 159.0 — миграция 847 чинила ту из
-- записей, что была видимой) и тип 'other' — парк держал тип hot_spring и
-- потому стоял в фильтре «Источники» на карте, с чего и начался разбор 14.08.
-- Обновление только выжившей записи и только если координата ушла дальше
-- ~2 км — ручные правки не перетираем. Идемпотентна.

CREATE OR REPLACE VIEW agent_route_knowledge AS
  SELECT
    p.ark_id                          AS id,
    NULL::text                        AS route_dedupe_key,
    NULL::uuid                        AS route_id,
    p.category,
    p.name                            AS title,
    p.description,
    p.lat,
    p.lng,
    p.source_url,
    p.source_name,
    NULL::tsvector                    AS search_text,
    '{}'::jsonb                       AS payload,
    NULL::text                        AS source_hash,
    NULL::timestamptz                 AS source_updated_at,
    NULL::timestamptz                 AS last_synced_at,
    p.created_at,
    p.updated_at,
    p.is_visible,
    p.location_type,
    p.activity_type,
    NULL::text                        AS kuzmich_review,
    p.zone,
    'place'::text                     AS kind,
    p.search_count,
    p.embedding
  FROM places p
  WHERE p.merged_into_id IS NULL
UNION ALL
  SELECT
    COALESCE(r.ark_id, r.id)          AS id,
    r.dedupe_key                      AS route_dedupe_key,
    NULL::uuid                        AS route_id,
    r.category,
    r.title,
    r.description,
    r.lat,
    r.lng,
    r.source_url,
    r.source_name,
    NULL::tsvector                    AS search_text,
    COALESCE(r.metadata, '{}'::jsonb) AS payload,
    NULL::text                        AS source_hash,
    NULL::timestamptz                 AS source_updated_at,
    NULL::timestamptz                 AS last_synced_at,
    r.created_at,
    r.updated_at,
    r.is_visible,
    NULL::character varying           AS location_type,
    r.activity_type,
    NULL::text                        AS kuzmich_review,
    r.zone,
    'route'::text                     AS kind,
    r.search_count,
    r.embedding
  FROM kamchatka_routes r;

-- Выжившая запись парка: координаты Wikipedia и тип «территория, не источник».
UPDATE places SET lat = 53.5000, lng = 159.0000, updated_at = NOW()
 WHERE name IN ('Природный парк «Налычево»', 'Природный парк Налычево')
   AND merged_into_id IS NULL
   AND (lat IS NULL OR abs(lat - 53.5000) > 0.02 OR abs(lng - 159.0000) > 0.03);

UPDATE places SET location_type = 'other', updated_at = NOW()
 WHERE name IN ('Природный парк «Налычево»', 'Природный парк Налычево')
   AND merged_into_id IS NULL
   AND location_type = 'hot_spring';

INSERT INTO _migrations (name)
VALUES ('863_hide_merged_places_from_view.sql')
ON CONFLICT (name) DO NOTHING;
