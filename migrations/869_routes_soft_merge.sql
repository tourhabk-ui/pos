-- 869_routes_soft_merge.sql
--
-- Актуатор слияния маршрутов, часть 1: мягкое слияние на данных.
--
-- Карт-бланш владельца 15.08 после обсуждения конструкции. Зеркало
-- механизма мест: колонка merged_into_id без FK (целостность — через
-- WHERE merged_into_id IS NULL, урок миграции 737) + фильтр слитых в
-- VIEW СРАЗУ, а не после конфуза (у мест витрина показывала слитые
-- записи, пока 863-я не закрыла дыру — маршрутам ту же дыру не заводим).
--
-- Тип колонки TEXT, а не UUID, сознательно: тип чужой колонки id — это
-- предположение, которое код выдаёт за знание (places.id оказался TEXT,
-- и ::uuid[] в первом дедупе мест упал на проде сухим прогоном).
-- Сравнение всегда id::text = merged_into_id — верно при любой схеме.
--
-- Текст VIEW — копия 863-й (у которой ветка мест уже фильтрует
-- merged_into_id) плюс ОДНО условие в ветке маршрутов.

ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS merged_into_id TEXT;
ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

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
  FROM kamchatka_routes r
  WHERE r.merged_into_id IS NULL;

INSERT INTO _migrations (name)
VALUES ('869_routes_soft_merge.sql')
ON CONFLICT (name) DO NOTHING;
