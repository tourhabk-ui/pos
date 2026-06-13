-- Migration 679: Re-hide commercial places after 651 restored them
--
-- Problem: migration 651 (restore_hidden_places) restores ALL hidden places
-- with description >= 50 chars, which includes commercial tour products that
-- migrations 159 and 161 had correctly hidden. Since 651 runs after 161
-- numerically, 161's work is undone.
--
-- This migration re-applies the exact same commercial-name filter as 161,
-- running after 651 so the filter sticks.
--
-- Idempotent: safe to run multiple times.

UPDATE places
SET    is_visible = false
WHERE  is_visible = true
  AND (
        -- "тур" / "туры" as standalone word
        name ~* '\mтур[аыуеовамиахй]?\M'

        -- Excursion / sightseeing label
     OR name ~* 'экскурс'

        -- Commercial journey / travel package
     OR name ~* 'путешестви'

        -- Adventure package
     OR name ~* 'приключени'

        -- Expedition product
     OR name ~* 'экспедиц'

        -- "Знакомство с …" sales copy
     OR name ~* 'знакомство с'

        -- Compound tour: SUP-тур, Джип-тур, багги-тур, etc.
     OR name ~* '-тур'

        -- Transfer service
     OR name ~* 'трансфер'

        -- Climbing tour product (not the geographic peak)
     OR name ~* 'восхождени'

        -- Ski touring product
     OR name ~* 'скитур'

        -- Multi-day package labels
     OR name ~* '\d+\s*(дней|ночей|дня|ночи|день|ночь)'

        -- Helicopter excursion labels (not a geographic location)
     OR name ~* 'вертолётн|вертолетн'

        -- "программа" — sales programme
     OR name ~* 'программ'

        -- Named hiking product (not a geographic trail)
     OR name ILIKE '%поход %'
     OR name ILIKE 'Поход %'
  )
  -- Keep real rock formation "Скала Тур"
  AND NOT name ILIKE 'Скала Тур';

INSERT INTO _migrations (name)
VALUES ('679_rehide_commercial_places_post_651.sql')
ON CONFLICT (name) DO NOTHING;
