-- 1013: опасности, которые на конкретном туре не выводятся — решением
-- владельца, а не правкой кода под один id.
--
-- С 24.09 (П6) опасности тура оператора выводятся из его типа активности,
-- если связи с маршрутом нет: rafting → «Речные пороги», «Опасность на
-- воде», «Медведи» (lib/safety/hazard-signals.ts). Для тура 27 «Сплав по
-- реке Быстрая» это противоречит его же описанию: сплав семейный, «без
-- опасных порогов». Две правды на одной карточке — хуже любой из них.
--
-- Решение владельца 25.09: «скрой пороги у тура 27». Скрывается именно
-- сигнал `rapids`; вода и медведи остаются — их описание тура не отрицает.
--
-- Пустой массив — «ничего не скрыто», это умолчание и для всех новых туров.
-- Какие имена допустимы — ключи HAZARD_KNOWLEDGE; неизвестное имя
-- ничего не скрывает (фильтр по совпадению), а не роняет выдачу.

ALTER TABLE operator_tours
  ADD COLUMN IF NOT EXISTS hazards_hidden TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN operator_tours.hazards_hidden IS
  'Сигналы опасности (ключи HAZARD_KNOWLEDGE), которые на этом туре не выводятся — решением владельца, с причиной в миграции. Пусто — не скрыто ничего.';

UPDATE operator_tours
   SET hazards_hidden = ARRAY['rapids']
 WHERE id = 27
   AND activity_type = 'rafting'
   AND NOT ('rapids' = ANY(hazards_hidden));

INSERT INTO _migrations (name)
VALUES ('1013_operator_tours_hazards_hidden.sql')
ON CONFLICT (name) DO NOTHING;
