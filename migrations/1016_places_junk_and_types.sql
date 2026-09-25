-- 1016_places_junk_and_types.sql
--
-- Перепись «экскурсия вместо места» (place-name-junk-scan, прогон 1, 25.09;
-- правило lib/places/name-junk.ts) и решение владельца того же дня:
-- «1 удали совсем … скорей всего коммерческий тур попал; 2 исправить;
-- 3 карт-бланш».
--
-- ── 1. Удаление пяти записей, которые не места ──────────────────────────
--
-- Все пять уже были скрыты с сайта, но MCP `get_place_info` видит скрытые
-- (правило 19.09) и подсунул «Долину гейзеров…» внешнему агенту среди
-- похожих на Курильское озеро. Удаление, а не скрытие — прямое слово
-- владельца. Имя сверяется с ожидаемым: если запись переименовали, её не
-- трогаем — удалять по одному id то, что стало другим, нельзя.
--
-- Связи (разбор 25.09): location_safety_profile, location_real_time_status,
-- route_waypoints, place_description_drafts уходят каскадом; reviews и
-- volcano_status обнуляют ссылку. У ai_route_images и place_aliases FK нет —
-- их строки удаляются явно, иначе останутся сиротами. При foreign_key_violation
-- — отступ к скрытию с WARNING, как в 940: «не смог удалить» не выглядит как
-- «удалил».
--
-- ── 2. Название-заметка ─────────────────────────────────────────────────
--
-- «искуственная фумарола, труба с газом, сильно шумит» — чья-то пометка с
-- опечаткой вместо имени. Описание уже рассказывает про трубу, свист и газ,
-- так что при переименовании ничего не теряется.
--
-- ── 3. Вид у перевалов ──────────────────────────────────────────────────
--
-- Пять перевалов записаны горой (`mountain`); вид `pass` («Перевал») платформа
-- знает (lib/places/location-types.ts). Каньоны оставлены долиной: вида
-- «каньон» у платформы нет, а заводить его ради трёх строк — отдельное решение.
--
-- Идемпотентно: отсутствующая или уже исправленная запись — no-op с NOTICE.

DO $$
DECLARE
  junk text[][] := ARRAY[
    ARRAY['de4cab89-ddf9-4d3e-9f1b-d91689b8f5b1', 'Долина гейзеров. Курильское озеро. Вулканы Горелый и Авача'],
    ARRAY['811b6b0e-0800-4ad3-8cf8-1b12e58302b7', 'Гонка на собачьих упряжках «Берингия. Авача». Гонка среди вулканов'],
    ARRAY['b883c8fb-355a-4b83-87e8-e4458895698b', 'Камчатка. Такие места'],
    ARRAY['e16e28ed-7fa9-42b7-bdcf-c8bd7687dcfb', 'Камчатка. Рискни покорить!'],
    ARRAY['a46dedd3-9ef4-41ed-aff2-f82b3413cb6a', 'Удивительные деревья России: Пущинская хранительница старины - Берёза Эрмана (каменная)']
  ];
  i int;
  pid text;
  expected text;
  pname text;
  park uuid;
BEGIN
  FOR i IN 1 .. array_length(junk, 1) LOOP
    pid := junk[i][1];
    expected := junk[i][2];
    SELECT name, ark_id INTO pname, park FROM places WHERE id = pid;

    IF pname IS NULL THEN
      RAISE NOTICE '[1016] % — уже отсутствует в places, делать нечего', pid;
      CONTINUE;
    END IF;
    IF pname <> expected THEN
      RAISE WARNING '[1016] % называется «%», а ждали «%» — не трогаю', pid, pname, expected;
      CONTINUE;
    END IF;

    BEGIN
      IF park IS NOT NULL THEN
        DELETE FROM ai_route_images WHERE route_id = park;
      END IF;
      DELETE FROM place_aliases WHERE place_id = pid;
      DELETE FROM places WHERE id = pid;
      RAISE NOTICE '[1016] удалено из places: % (%)', pname, pid;
    EXCEPTION WHEN foreign_key_violation THEN
      UPDATE places SET is_visible = false, updated_at = NOW() WHERE id = pid;
      RAISE WARNING '[1016] % (%) держат зависимые строки — не удалено, а скрыто (is_visible=false)', pname, pid;
    END;
  END LOOP;
END $$;

UPDATE places
   SET name = 'Искусственная фумарола', updated_at = NOW()
 WHERE id = '66c4190b-c632-4182-861a-ef210081e333'
   AND name = 'искуственная фумарола, труба с газом, сильно шумит';

UPDATE places
   SET location_type = 'pass', updated_at = NOW()
 WHERE id IN (
         '9bf00669-5101-4afc-a35a-429afc4a5f41', -- Перевал Тенуева
         '29e415fa-2b63-4a8b-ae1b-a110fa432aa9', -- Перевал Малыш
         '5b8dddd9-854c-4b56-8142-71a3e5c7757f', -- Перевал Рыжий
         '46068a7b-c0a7-4e47-aff1-c69ee48f85e3', -- Перевал Двойной
         '5cdb784e-c9aa-45ea-8afd-004e0216eb58'  -- Перевал Шмидта Западный 1Б
       )
   AND location_type = 'mountain'
   AND name LIKE 'Перевал %';
