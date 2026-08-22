-- 905: место, которого у нас нет (владелец 22.08, стоя на Диких озерках).
--
-- «А если места нет и в выборе тоже?» — и это был тупик. Форма умела
-- сказать «ваша запись врёт», но не умела сказать «здесь есть то, чего у
-- вас нет вовсе». А это самое ценное, что приносят из поля: стоянка, брод,
-- развилка, источник, изба. Ошибку в существующей записи мы рано или поздно
-- поймаем сами переписью; место, которого нет в базе, не найдёт никто и
-- никогда, кроме человека, который на нём стоит.
--
-- Устройство: та же очередь, тот же разбор, та же обратимость. Не заводим
-- ни отдельной таблицы, ни отдельного пути — новая находка это ещё один
-- род цели проверки:
--
--   target_kind = 'route' | 'place'  — проверка НАШЕЙ записи, id обязателен
--   target_kind = 'new'              — находка, id НЕТ по замыслу
--
-- Отсутствие id у находки — не пропуск и не ошибка: связывать её не с чем,
-- потому что записи ещё нет. Ограничение делает это явным, чтобы «нет id»
-- нельзя было спутать с «id потеряли».

ALTER TABLE route_field_checks
  ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE route_field_checks
  ADD COLUMN IF NOT EXISTS proposed_name TEXT
    CHECK (proposed_name IS NULL OR char_length(proposed_name) <= 120);

DO $$
BEGIN
  -- Старое ограничение рода цели заменяется: имя у него сгенерированное,
  -- поэтому ищем по колонке, а не по имени.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'route_field_checks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%target_kind%'
      AND pg_get_constraintdef(oid) NOT LIKE '%new%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE route_field_checks DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'route_field_checks'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%target_kind%'
        AND pg_get_constraintdef(oid) NOT LIKE '%new%'
      LIMIT 1
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_checks_target_kind_check2'
  ) THEN
    ALTER TABLE route_field_checks
      ADD CONSTRAINT route_field_checks_target_kind_check2
      CHECK (target_kind IN ('route', 'place', 'new'));
  END IF;

  -- «Нет id» законно РОВНО у находки. Иначе это потерянная связь.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_checks_target_id_presence'
  ) THEN
    ALTER TABLE route_field_checks
      ADD CONSTRAINT route_field_checks_target_id_presence
      CHECK ((target_kind = 'new') = (target_id IS NULL));
  END IF;

  -- Вердикт находки — свой: 'new_place'. Прежние остаются.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'route_field_checks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%confirmed%'
      AND pg_get_constraintdef(oid) NOT LIKE '%new_place%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE route_field_checks DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'route_field_checks'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%confirmed%'
        AND pg_get_constraintdef(oid) NOT LIKE '%new_place%'
      LIMIT 1
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_checks_verdict_check2'
  ) THEN
    ALTER TABLE route_field_checks
      ADD CONSTRAINT route_field_checks_verdict_check2
      CHECK (verdict IN (
        'confirmed', 'coords_wrong', 'not_found',
        'line_wrong', 'description_wrong', 'access_changed', 'other',
        'new_place'));
  END IF;
END $$;

-- Находки разбираются отдельной кучей: по ним заводят записи, а не правят.
CREATE INDEX IF NOT EXISTS idx_route_field_checks_new
  ON route_field_checks (created_at DESC)
  WHERE target_kind = 'new' AND status = 'pending';
