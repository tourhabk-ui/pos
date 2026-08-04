-- Migration 812: даты в календаре — у туров не было ни одной строки занятости
--
-- Симптом: на карточке тура нет календаря, только ручной ввод даты. Причина не
-- в UI: `TourDateField` показывает календарь, если `/api/tours/[id]/slots`
-- вернул хоть одну дату, иначе честно падает в ручной ввод. А слотов не было
-- вовсе.
--
-- Почему их не было: миграция 060 создавала слоты ОДНИМ CTE вместе с туром и
-- вставляла `gen_random_uuid()` в `tour_availability.id`, а он BIGSERIAL
-- (миграция 040) — вставка падала, откатывая весь CTE. В 800 я слоты сознательно
-- не трогал («хрупкая часть»), поэтому дыра дожила до сюда.
--
-- Что считаем честным основанием для даты: СЕЗОН, объявленный самим оператором
-- (`operator_tours.season_start/season_end`). Даты вне сезона не выдумываем, а
-- турам без объявленного сезона не создаём ничего — там ручной ввод остаётся
-- правдой. Вместимость берём из `max_participants` того же тура, не из головы.
--
-- Окно строим на ТЕКУЩИЙ год по месяцу и дню сезона: сезон — величина годовая
-- («Июн — Сен»), и привязка к году из БД оставила бы календарь пустым в
-- следующем сезоне. Начало окна не раньше сегодняшнего дня — прошедшие даты в
-- календаре бессмысленны.
--
-- Идемпотентна: уникального ключа на (тур, дата) в схеме нет, поэтому вставляем
-- только те даты, которых у тура ещё нет. booked_slots не трогаем — его
-- единственный писатель платёжный вебхук.

INSERT INTO tour_availability (operator_tour_id, date, day_of_week, available_slots, booked_slots, created_at)
SELECT
  t.id,
  d.day::date,
  EXTRACT(ISODOW FROM d.day)::int - 1,          -- 0 = понедельник
  GREATEST(COALESCE(t.max_participants, 1), 1),
  0,
  NOW()
FROM operator_tours t
JOIN partners p ON p.id = t.operator_id
CROSS JOIN LATERAL (
  SELECT
    GREATEST(
      MAKE_DATE(
        EXTRACT(YEAR FROM CURRENT_DATE)::int,
        EXTRACT(MONTH FROM t.season_start)::int,
        EXTRACT(DAY   FROM t.season_start)::int
      ),
      CURRENT_DATE
    ) AS win_start,
    MAKE_DATE(
      EXTRACT(YEAR FROM CURRENT_DATE)::int,
      EXTRACT(MONTH FROM t.season_end)::int,
      EXTRACT(DAY   FROM t.season_end)::int
    ) AS win_end
) w
CROSS JOIN LATERAL generate_series(w.win_start::timestamp, w.win_end::timestamp, INTERVAL '1 day') AS d(day)
WHERE t.deleted_at IS NULL
  AND t.is_active = TRUE
  AND t.is_published = TRUE
  AND t.season_start IS NOT NULL
  AND t.season_end   IS NOT NULL
  AND w.win_start <= w.win_end
  -- только наши реальные партнёры: чужим турам занятость не сочиняем
  AND (
       p.slug = 'kamchatka-rafting'
    OR p.slug IN ('fishingkam', 'kamchatskaya-rybalka', 'rybalka-po-kamchatski')
    OR p.name ILIKE '%камчатская рыбалка%'
    OR p.name ILIKE '%рыбалка по-камчатски%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM tour_availability ta
     WHERE ta.operator_tour_id = t.id
       AND ta.date = d.day::date
  );
