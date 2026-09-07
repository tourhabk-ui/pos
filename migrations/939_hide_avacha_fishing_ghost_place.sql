-- 939_hide_avacha_fishing_ghost_place.sql
--
-- «Река Авача — рыбалка» уходит с витрины мест (слово владельца 07.09).
--
-- Владелец на скрине /map: точка «Река Авача — рыбалка» стоит на месте,
-- которое к настоящей рыбалке отношения не имеет — сама рыбалка идёт на
-- реке Камчатка, а это коммерческий продукт (тур), не географический факт.
-- Ровно та подмена, от которой предостерегает §9 CLAUDE.md: «Точка = место.
-- Тур = коммерция. Не смешивать» — кто-то (импорт/скрейп) завёл activity-
-- пункт как строку в `places`, и она стала попадать в выдачу
-- `/api/routes?kind=place` наравне с настоящими местами (agent_route_knowledge,
-- UNION places+kamchatka_routes, §4.1).
--
-- Имя матчится по двум подстрокам («авача» + «рыбалк»), не литералом: точный
-- регистр/тире в БД не подтверждён (сессия без доступа к базе — сверка
-- только по скрину). Если совпадений больше одного — ни одно не трогаем и
-- называем находку в логе: массовая правка по неточному совпадению опаснее,
-- чем оставленный баг (§4.0, «не смог проверить» ≠ «делай что-нибудь»).
--
-- Скрытие, не удаление — тот же выбор, что и в 933 («маршрут-призрак»):
-- на `places` смотрят FK (location_safety_profile, location_real_time_status,
-- ai_route_images, route_waypoints — §4.1), и `is_visible` уже часть
-- контракта выдачи (places-export: `p.is_visible = true`; agent_route_knowledge:
-- `ark.is_visible = TRUE`). Обратимо, если правка окажется неточной.
--
-- Идемпотентно: повторный прогон на уже скрытой записи — no-op.

DO $$
DECLARE
  v_count integer;
  v_names text;
BEGIN
  SELECT count(*), string_agg(format('%L (id=%s)', name, id), ', ')
    INTO v_count, v_names
    FROM places
   WHERE is_visible = true
     AND name ILIKE '%авач%'
     AND name ILIKE '%рыбалк%';

  IF v_count = 0 THEN
    RAISE NOTICE '[939] совпадений «авача»+«рыбалк» среди видимых мест нет — уже скрыто или названо иначе';
    RETURN;
  ELSIF v_count > 1 THEN
    RAISE WARNING '[939] совпадений % — не одно, ничего не трогаю: %', v_count, v_names;
    RETURN;
  END IF;

  UPDATE places
     SET is_visible = false,
         updated_at = NOW()
   WHERE is_visible = true
     AND name ILIKE '%авач%'
     AND name ILIKE '%рыбалк%';

  RAISE NOTICE '[939] скрыто с витрины мест: %', v_names;
END $$;
