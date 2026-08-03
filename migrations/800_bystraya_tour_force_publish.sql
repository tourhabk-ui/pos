-- Migration 800: гарантированно опубликовать тур «Сплав по реке Быстрая»
--
-- Симптом: карточка сплава не появляется на проде («Подходит вам сейчас»
-- показывает маршрут, каталог пуст по турам). Причина — на стороне прод-БД, и
-- прошлые миграции (060 создаёт тур, 789 публикует) могли не сработать:
--   • 060 создаёт тур и слоты ОДНИМ атомарным CTE, а вставка слотов берёт
--     gen_random_uuid() в tour_availability.id (BIGINT) — при несовпадении типа
--     весь CTE откатывается, и СТРОКА ТУРА не создаётся вовсе;
--   • тогда 789/793–797 обновляют 0 строк, но записываются как «применённые»
--     и больше НИКОГДА не повторяются (ловушка идемпотентного трекинга).
--
-- Эта миграция самодостаточна и НЕ зависит от истории: свежее имя → выполнится
-- на ближайшем деплое; чинит все случаи (тур отсутствует / не опубликован /
-- помечен удалённым / не тот activity_type). Слоты НЕ трогаем (та самая хрупкая
-- часть) — для видимости в каталоге достаточно is_active+is_published+deleted_at.
-- Идемпотентна.

-- 1. Партнёр (если его почему-то нет)
INSERT INTO partners (slug, name, is_public, created_at)
VALUES ('kamchatka-rafting', 'Камчатка Рафтинг', TRUE, NOW())
ON CONFLICT (slug) DO NOTHING;

-- 2. Тур — создаём, только если его ещё нет (без хрупкого CTE со слотами).
--    id НЕ указываем: столбец BIGSERIAL (авто-BIGINT). Именно здесь и лежит
--    корень: 060 вставляла gen_random_uuid() в id → тип не совпал → строка тура
--    не создавалась. Пусть последовательность выдаёт id сама.
INSERT INTO operator_tours (
  operator_id, title, description, activity_type, location_type,
  base_price, price_unit, location_name, max_participants,
  is_published, is_active, created_at
)
SELECT
  p.id,
  'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ',
  E'Захватывающий сплав по реке Быстрая с остановкой на Малкинских горячих источниках.\n\nВ программе:\n- Выезд из Петропавловска-Камчатского (Паратунская зона отдыха)\n- п. Сокочи (пирожковый перекус)\n- Инструктаж на реке Быстрая, получение снаряжения\n- Сплав с гидом\n- Обед: уха из лосося, нарезки, чай, кофе\n- Малкинские термальные источники (купание)\n- Возвращение в город\n\nВ стоимость входит: трансфер, питание, гид, повар, удочки, снаряжение.',
  'rafting', 'river', 13000, 'per_person',
  'Река Быстрая, Малкинские горячие источники', 6,
  TRUE, TRUE, NOW()
FROM partners p
WHERE p.slug = 'kamchatka-rafting'
  AND NOT EXISTS (
    SELECT 1 FROM operator_tours ot
     WHERE ot.operator_id = p.id
       AND ot.title = 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'
  );

-- 3. Принудительно вывести в каталог (публикация + активность + снять удаление +
--    правильная категория «Сплав»), если тур уже есть в любом состоянии.
UPDATE operator_tours ot
   SET is_published = TRUE,
       is_active    = TRUE,
       deleted_at   = NULL,
       activity_type = 'rafting',
       updated_at   = NOW()
  FROM partners p
 WHERE p.id = ot.operator_id
   AND p.slug = 'kamchatka-rafting'
   AND ot.title = 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'
   AND (ot.is_published IS DISTINCT FROM TRUE
        OR ot.is_active IS DISTINCT FROM TRUE
        OR ot.deleted_at IS NOT NULL
        OR ot.activity_type IS DISTINCT FROM 'rafting');
