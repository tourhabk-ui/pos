-- Migration 674: Fix ark_view_insert() trigger — add lat/lng to INSERT
-- Bug: INSERT trigger on agent_route_knowledge VIEW dropped lat/lng,
-- causing importers that write via VIEW to create routes without coordinates.

BEGIN;

CREATE OR REPLACE FUNCTION ark_view_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kamchatka_routes
    (id, dedupe_key, slug, title, description, category,
     lat, lng,
     source_url, source_name, metadata, is_visible,
     activity_type, zone, created_at, updated_at)
  VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    COALESCE(NEW.route_dedupe_key, NEW.title),
    LOWER(REGEXP_REPLACE(COALESCE(NEW.title, 'route'), '[^a-zа-я0-9]+', '-', 'g')),
    NEW.title,
    NEW.description,
    COALESCE(NEW.category, 'ekskursii'),
    NEW.lat,
    NEW.lng,
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
        lat         = COALESCE(EXCLUDED.lat, kamchatka_routes.lat),
        lng         = COALESCE(EXCLUDED.lng, kamchatka_routes.lng),
        source_url  = EXCLUDED.source_url,
        updated_at  = NOW();

  RETURN NEW;
END;
$$;

COMMIT;
