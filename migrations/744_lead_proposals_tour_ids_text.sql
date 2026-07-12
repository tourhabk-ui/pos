-- 744: lead_proposals — id туров это operator_tours (INTEGER), не legacy tours (UUID).
--
-- Баг (скриншот владельца 2026-07-12): кнопка «AI-обработать» на лиде падала
-- с «invalid input syntax for type uuid: "31"». Схема 083 создавала
-- primary_tour_id UUID REFERENCES tours(id) и alt_tour_ids UUID[], но
-- подборщик туров (lead-processor) давно работает с operator_tours,
-- чей id — целочисленный. INSERT предложения ронял всю AI-обработку.
-- Читающий код уже готов к тексту: JOIN идёт через t.id::text.
--
-- Идемпотентно: повторный прогон ALTER TYPE TEXT/TEXT[] — no-op с USING.

ALTER TABLE lead_proposals DROP CONSTRAINT IF EXISTS lead_proposals_primary_tour_id_fkey;

ALTER TABLE lead_proposals ALTER COLUMN alt_tour_ids DROP DEFAULT;
ALTER TABLE lead_proposals ALTER COLUMN primary_tour_id TYPE TEXT USING primary_tour_id::text;
ALTER TABLE lead_proposals ALTER COLUMN alt_tour_ids TYPE TEXT[] USING alt_tour_ids::text[];
ALTER TABLE lead_proposals ALTER COLUMN alt_tour_ids SET DEFAULT '{}';
