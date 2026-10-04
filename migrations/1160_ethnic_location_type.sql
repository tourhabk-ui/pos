-- 1160: тип «Этнокультурное место» (ethnic) — стойбище и этнодеревня
-- Created: 2026-10-04
--
-- Владелец 04.10 на вопрос «у Кайнырана тип „Историческое место“, а это
-- действующее стойбище; своего типа нет»: «завести». Подпись типа — в
-- lib/places/location-types.ts. Схемы не меняет: location_type — текст без
-- CHECK, тип заводится словарём кода и этой разметкой.
--
-- Кому тип — по улике в самом имени места, не по догадке:
--   «Этническое стойбище Кайныран»          historical → ethnic
--   «Ительменская деревня — этнотуризм»     settlement → ethnic
-- Второе — не населённый пункт: имя само называет этнотуризм. Перепись
-- каталога пробой 687 (поиск «стойбищ», «этно», все historical) других
-- стойбищ и этнокомплексов не нашла. «Шаманская поляна у Эссо» не тронута:
-- её имя этнокомплекса не называет.
--
-- Прицел — id, имя и прежний тип: переразмечено раньше — no-op.

BEGIN;

UPDATE places
   SET location_type = 'ethnic', updated_at = NOW()
 WHERE id::text = 'eaab2afe-577e-4532-b5b5-93ace0018f00'
   AND name = 'Этническое стойбище Кайныран'
   AND location_type = 'historical';

UPDATE places
   SET location_type = 'ethnic', updated_at = NOW()
 WHERE id::text = 'b8663d1c-33f6-4aec-a086-cfb3d10268a8'
   AND name = 'Ительменская деревня — этнотуризм'
   AND location_type = 'settlement';

COMMIT;

-- Rollback:
-- UPDATE places SET location_type = 'historical' WHERE id::text = 'eaab2afe-577e-4532-b5b5-93ace0018f00' AND location_type = 'ethnic';
-- UPDATE places SET location_type = 'settlement' WHERE id::text = 'b8663d1c-33f6-4aec-a086-cfb3d10268a8' AND location_type = 'ethnic';
