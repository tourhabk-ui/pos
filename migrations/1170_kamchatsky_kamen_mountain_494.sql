-- 1170: «Камчатский камень» — гора, 494 м (по OSM/MAPS.ME)
-- Created: 2026-10-04
--
-- Владелец 04.10 прислал карточку места из карт на данных OSM (MAPS.ME):
-- «Гора · 494 m», 52.974428, 158.73553. Координата у нас уже та же (сдвинута
-- к точке OSM 03.10, place-coords run 24), а тип записан не тот — род места
-- выводил его как вулкан/скалу. На вопрос «тип, высоту и описание или только
-- тип и высоту» владелец ответил: «тип и высоту». Описание не трогается.
--
--   location_type → 'mountain' (только с прежнего значения, не поверх ручной
--                   правки, сделанной после);
--   altitude_m    → 494 в профиле места, если строка профиля есть и высота в
--                   ней пустая или другая. Высоту шаблон 070 не выдумывал
--                   (lib/safety/profile-source.ts), поэтому profile_source не
--                   меняется — правится одно поле. Строки профиля нет — не
--                   заводим: умолчания таблицы принесли бы лимиты и опасности,
--                   которых никто не мерил; исход говорит об этом вслух.
--
-- Геометрия места не меняется — перезалив пакетов карты не нужен для точки,
-- но тип на полевой карте читается из пакетов: перезалив — следующим слоем.
--
-- IDEMPOTENT

BEGIN;

UPDATE places SET location_type = 'mountain', updated_at = NOW()
 WHERE id = 'dac787de-8f88-4ae1-8711-27b44382139b'
   AND location_type IS DISTINCT FROM 'mountain'
   AND location_type IN ('volcano', 'rock', 'other');

UPDATE location_safety_profile sp
   SET altitude_m = 494, updated_at = NOW()
  FROM places p
 WHERE p.id = 'dac787de-8f88-4ae1-8711-27b44382139b'
   AND sp.agent_route_id = p.ark_id
   AND sp.altitude_m IS DISTINCT FROM 494;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_type text;
  v_alt  integer;
  v_has  boolean;
BEGIN
  SELECT p.location_type INTO v_type FROM places p WHERE p.id = 'dac787de-8f88-4ae1-8711-27b44382139b';
  IF v_type IS NULL THEN
    RAISE WARNING '[1170] записи «Камчатский камень» нет — ничего не сделано';
    RETURN;
  END IF;
  IF v_type <> 'mountain' THEN
    RAISE WARNING '[1170] тип не сменён — сейчас «%» (не из ожидаемых volcano/rock/other)', v_type;
  END IF;
  SELECT true, sp.altitude_m INTO v_has, v_alt
    FROM location_safety_profile sp JOIN places p ON sp.agent_route_id = p.ark_id
   WHERE p.id = 'dac787de-8f88-4ae1-8711-27b44382139b' LIMIT 1;
  IF v_has IS NULL THEN
    RAISE WARNING '[1170] строки профиля безопасности нет — высота 494 м не записана';
  ELSIF v_alt IS DISTINCT FROM 494 THEN
    RAISE WARNING '[1170] высота не записана — сейчас %', v_alt;
  END IF;
END $$;

COMMIT;
