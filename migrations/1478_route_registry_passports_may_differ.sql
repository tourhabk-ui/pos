-- Migration 1478: паспорт реестра, к карточке маршрута не привязанный, —
-- «в официальном паспорте — N км, маршрут в паспорте может отличаться»
-- (#3568, слово владельца 20.11 «2 дописать»).
--
-- У шести карточек (семь паспортов) есть официальный паспорт в реестре visitkamchatka.ru с тем
-- же названием, но тот ли это маршрут, по карточке не понять: старт и финиш
-- не подписаны, длина другого рода. У Вилючинского перевала в паспорте —
-- другая нитка (76 км на машине от п. Геологи против 12,1 км у перевала).
-- Паспортную длину на эти карточки не переносим (миграция 1477 их не
-- трогала); карточка говорит, что в паспорте и что маршрут там может
-- отличаться, со ссылкой на PDF. Слова — lib/routes/registry-passport.ts.
--
-- Источник длины — чтение PDF глазами 20.11.2026, 17:07–17:08 UTC: ответ
-- tourhabk-ui/flo-claude answers/2026-11-20-passports-batch-2.md (commit
-- 4a403ae7958b0021f95b325ef33d3a0eb8f730f2), совпало со второй сверкой
-- (таблица #3568, строки 1, 4, 5, 6, 7, 16, 17). Везде «в обе стороны».
--
-- Колонка — список { url, km, side, label }: у Вилючинского водопада два
-- паспорта, летний и зимний, оба «4 км (в обе стороны)».
--
-- Откат: ALTER TABLE kamchatka_routes DROP CONSTRAINT IF EXISTS
-- kamchatka_routes_registry_passports_array; ALTER TABLE kamchatka_routes
-- DROP COLUMN IF EXISTS registry_passports.

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS registry_passports JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'kamchatka_routes_registry_passports_array'
       AND conrelid = 'kamchatka_routes'::regclass
  ) THEN
    ALTER TABLE kamchatka_routes
      ADD CONSTRAINT kamchatka_routes_registry_passports_array
      CHECK (registry_passports IS NULL OR jsonb_typeof(registry_passports) = 'array');
  END IF;
END $$;

UPDATE kamchatka_routes k
SET registry_passports = v.refs,
    updated_at = NOW()
FROM (VALUES
  ('vilyuchinskij-vodopad', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/vilyuchinsky_waterfall_summer.pdf","km":4,"side":"в обе стороны","label":"летний"},
     {"url":"https://visitkamchatka.ru/upload/route_passports/vilyuchinsky_waterfall_winter.pdf","km":4,"side":"в обе стороны","label":"зимний"}
   ]'::jsonb),
  ('vodopad-babij-kamen-marshrut', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/babiy_summer.PDF","km":5,"side":"в обе стороны","label":null}
   ]'::jsonb),
  ('ozero-kotelnoe-marshrut', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/kotelnoe_summer.PDF","km":80,"side":"в обе стороны","label":null}
   ]'::jsonb),
  ('ozero-ovalnoe-marshrut', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/ovalnoe_summer.PDF","km":23,"side":"в обе стороны","label":null}
   ]'::jsonb),
  ('visitkamchatka-malkin-all-seasones', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/malkin_all_seasones.PDF","km":240,"side":"в обе стороны","label":null}
   ]'::jsonb),
  ('vilyuchinskij-pereval-marshrut', '[
     {"url":"https://visitkamchatka.ru/upload/route_passports/vilyuchinsky_pereval_avto.pdf","km":76,"side":"в обе стороны","label":null}
   ]'::jsonb)
) AS v(slug, refs)
WHERE k.slug = v.slug
  AND k.merged_into_id IS NULL
  AND k.registry_passports IS DISTINCT FROM v.refs;
