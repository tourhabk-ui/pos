-- Migration 677: Ensure agent_route_knowledge is a VIEW, not a TABLE
--
-- Problem: migrations 157/160/663 all do CREATE OR REPLACE VIEW, which silently
-- fails when agent_route_knowledge is still a TABLE (error: "is not a view").
-- The migration runner's isAlreadyExistsError() does not catch this error, so
-- the migrations are not recorded as applied and retry on every deploy.
--
-- Symptom on production: /routes shows 0 results because the TABLE is either
-- empty or has no rows matching is_visible = TRUE AND kind = 'place'.
--
-- Fix:
--   1. If agent_route_knowledge is a TABLE, DROP it CASCADE (removes FK constraints
--      in operator_tours, location_safety_profile, location_real_time_status,
--      ai_route_images — FK data is preserved, only constraints are dropped)
--   2. Recreate the VIEW (idempotent if already a VIEW)
--   3. Recreate INSTEAD OF triggers (from migration 663, idempotent)
--
-- Idempotent: safe to run even if already a VIEW.

BEGIN;

-- ── Step 1: Convert TABLE → VIEW if needed ────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agent_route_knowledge'
      AND c.relkind = 'r'
      AND n.nspname = 'public'
  ) THEN
    DROP TABLE agent_route_knowledge CASCADE;
    RAISE NOTICE 'Migration 677: dropped agent_route_knowledge TABLE → recreating as VIEW';
  END IF;
END $$;

-- ── Step 2: Create/replace VIEW ───────────────────────────────────────────────
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
    p.search_count
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
    r.search_count
  FROM kamchatka_routes r;

-- ── Step 3: INSTEAD OF triggers (idempotent — OR REPLACE / DROP IF EXISTS) ────

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

CREATE OR REPLACE FUNCTION ark_view_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kamchatka_routes
    (id, dedupe_key, slug, title, description, category,
     source_url, source_name, metadata, is_visible,
     activity_type, zone, created_at, updated_at)
  VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    COALESCE(NEW.route_dedupe_key, NEW.title),
    LOWER(REGEXP_REPLACE(COALESCE(NEW.title, 'route'), '[^a-zа-я0-9]+', '-', 'g')),
    NEW.title,
    NEW.description,
    COALESCE(NEW.category, 'ekskursii'),
    NEW.source_url,
    NEW.source_name,
    COALESCE(NEW.payload, '{}'),
    COALESCE(NEW.is_visible, TRUE),
    NEW.activity_type,
    NEW.zone,
    NOW(),
    NOW()
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET title       = EXCLUDED.title,
        description = COALESCE(EXCLUDED.description, kamchatka_routes.description),
        source_url  = EXCLUDED.source_url,
        updated_at  = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ark_insert ON agent_route_knowledge;
CREATE TRIGGER ark_insert
  INSTEAD OF INSERT ON agent_route_knowledge
  FOR EACH ROW EXECUTE FUNCTION ark_view_insert();

COMMIT;
