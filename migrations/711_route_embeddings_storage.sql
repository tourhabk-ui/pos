-- Migration 711: восстановить хранение эмбеддингов семантического поиска
--
-- Проблема: lib/ai/embeddings.ts читает `embedding FROM agent_route_knowledge`,
-- а scripts/index-route-embeddings.ts пишет туда же, но после превращения
-- agent_route_knowledge в VIEW (миграции 160/663/677) колонки embedding в нём
-- нет. Каждый вызов semanticSearch() падает SQL-ошибкой:
--   - /api/routes/search всегда уходит в ILIKE-фоллбэк
--   - RAG Кузьмича теряет семантическую ветку (.catch(() => []))
-- Эмбеддинги (~259 строк) остались в _agent_route_knowledge_legacy на проде.
--
-- Fix:
--   1. embedding JSONB в master-таблицах (places, kamchatka_routes)
--   2. Backfill из _agent_route_knowledge_legacy, если таблица существует
--   3. VIEW переиздаётся с embedding (новая колонка в конце — допустимо
--      для CREATE OR REPLACE VIEW)
--   4. INSTEAD OF UPDATE триггер маппит NEW.embedding в master-таблицы,
--      чтобы индексатор продолжал работать без изменений
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

-- ── Step 1: колонки в master-таблицах ─────────────────────────────────────────
ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS embedding JSONB;
ALTER TABLE places           ADD COLUMN IF NOT EXISTS embedding JSONB;

-- ── Step 2: backfill из legacy (таблица есть только на проде) ─────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_agent_route_knowledge_legacy'
      AND column_name  = 'embedding'
  ) THEN
    UPDATE kamchatka_routes r
    SET    embedding = l.embedding::jsonb
    FROM   _agent_route_knowledge_legacy l
    WHERE  COALESCE(r.ark_id, r.id) = l.id
      AND  l.embedding IS NOT NULL
      AND  r.embedding IS NULL;

    UPDATE places p
    SET    embedding = l.embedding::jsonb
    FROM   _agent_route_knowledge_legacy l
    WHERE  p.ark_id = l.id
      AND  l.embedding IS NOT NULL
      AND  p.embedding IS NULL;

    RAISE NOTICE 'Migration 711: embeddings backfilled from legacy table';
  ELSE
    RAISE NOTICE 'Migration 711: legacy table absent — skip backfill (reindex via scripts/index-route-embeddings.ts)';
  END IF;
EXCEPTION WHEN others THEN
  -- Неожиданный тип/содержимое legacy-колонки не должны ронять деплой:
  -- без backfill семантика просто остаётся пустой до переиндексации.
  RAISE NOTICE 'Migration 711: backfill skipped (%)', SQLERRM;
END $$;

-- ── Step 3: VIEW с embedding (колонка добавлена в конец) ──────────────────────
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

-- ── Step 4: триггер UPDATE маппит embedding в master-таблицы ──────────────────
-- Копия ark_view_update из миграции 677 + строка embedding в обеих ветках.
CREATE OR REPLACE FUNCTION ark_view_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE places
  SET
    name          = COALESCE(NEW.title,         name),
    description   = COALESCE(NEW.description,   description),
    category      = COALESCE(NEW.category,       category),
    lat           = COALESCE(NEW.lat,            lat),
    lng           = COALESCE(NEW.lng,            lng),
    is_visible    = COALESCE(NEW.is_visible,     is_visible),
    location_type = COALESCE(NEW.location_type,  location_type),
    activity_type = COALESCE(NEW.activity_type,  activity_type),
    zone          = COALESCE(NEW.zone,           zone),
    embedding     = COALESCE(NEW.embedding,      embedding),
    updated_at    = NOW()
  WHERE ark_id = OLD.id;

  IF NOT FOUND THEN
    UPDATE kamchatka_routes
    SET
      title         = COALESCE(NEW.title,         title),
      description   = COALESCE(NEW.description,   description),
      category      = COALESCE(NEW.category,       category),
      lat           = COALESCE(NEW.lat::numeric,   lat),
      lng           = COALESCE(NEW.lng::numeric,   lng),
      is_visible    = COALESCE(NEW.is_visible,     is_visible),
      activity_type = COALESCE(NEW.activity_type,  activity_type),
      zone          = COALESCE(NEW.zone,           zone),
      metadata      = COALESCE(NEW.payload,        metadata),
      embedding     = COALESCE(NEW.embedding,      embedding),
      updated_at    = NOW()
    WHERE COALESCE(ark_id, id) = OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ark_update ON agent_route_knowledge;
CREATE TRIGGER ark_update
  INSTEAD OF UPDATE ON agent_route_knowledge
  FOR EACH ROW EXECUTE FUNCTION ark_view_update();

COMMIT;
