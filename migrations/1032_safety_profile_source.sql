-- 1032_safety_profile_source.sql
--
-- Откуда взялись опасности места. Пока этого не записано, карточка выдаёт
-- шаблон по типу за измеренный факт.
--
-- ── Что стоит в данных ───────────────────────────────────────────────────
--
-- Слой безопасности мест завела миграция 070 (и её близнец 0645) ОДНИМ
-- запросом по всем записям, выводя всё из `location_type`:
--
--   CASE WHEN location_type = 'volcano'
--        THEN ARRAY['avalanche','rockfall','thermal','altitude']
--   CASE WHEN location_type = 'volcano' THEN 30   -- лимит посещения
--   CASE WHEN location_type = 'volcano' THEN 4    -- сложность
--
-- Турист читает это как факты о месте: блок «Что знать» рисует бейджи
-- опасностей, «Лимит посещения — 30 человек в сутки» стоит рядом с высотой и
-- расстоянием до медпомощи, а Кузьмич проговаривает опасности словами
-- («Есть лавинная опасность»).
--
-- Цену уже платили поимённо. Миграции 972-974 снимали с Сопки Никольской —
-- стометрового холма с городским парком в центре Петропавловска — «лавины,
-- камнепад, термальные поля, высотную болезнь»: четыре ложных утверждения,
-- каждое из шаблона вулкана. 992 — то же для Перевала Сноубордистов. Правки
-- разовые, механизм остался: шаблон по типу разносит ошибку типа дальше, чем
-- видно с места правки.
--
-- ── Что делает эта миграция ──────────────────────────────────────────────
--
-- Записывает ПРОИСХОЖДЕНИЕ строки, как это уже сделано у координаты места
-- (`places.coord_source`) и у лимита посетителей (`places.visitor_limit_source`,
-- миграция 1017, где источник обязателен по CHECK).
--
--   type_template — строка целиком совпадает с тем, что написал шаблон 070
--                   или 0645 для её типа. Это ДОКАЗАННАЯ выдумка: значения
--                   не измеряли, их вывели из одного поля;
--   manual        — записал человек (ставит тот, кто пишет; здесь не
--                   присваивается никому: доказательства ручной записи в
--                   данных нет);
--   unknown       — не установлено. Строка отличается от шаблона хотя бы
--                   одним полем, но чем именно её заполняли, мы не знаем.
--
-- Отпечаток проверяется по ПЯТИ полям сразу (лимит, размер группы, сложность,
-- рельеф, опасности) и по ОБОИМ вариантам шаблона: 0645 добавил ветки для
-- рыбалки, которых нет в 070. Тронул человек любое из полей — строка уже не
-- `type_template`, а `unknown`, и карточка её показывает: мы прячем только то,
-- что можем доказать. Ошибка в эту сторону стоит надписи «у нас не записано»
-- вместо верного значения; ошибка в другую сторону стоит человека, который
-- поверил лавинам в городском парке.
--
-- ── Загрузка и счётчики посетителей ──────────────────────────────────────
--
-- `current_crowds`, `tourists_today`, `tourists_hour` не пишет НИКТО: grep по
-- всему репозиторию находит только читателей. Строки завела та же миграция
-- 070 (`INSERT ... (agent_route_id, recommender_status) SELECT id, 'green'`),
-- то есть у всех стоит DEFAULT 0. А единственный читатель `current_crowds`
-- (`components/places/PlaceRealtimeStatus.tsx`) считает это шкалой 1-5 и на
-- ноль отвечает зелёным «Свободно» — рядом со строкой «Проверили <время>»,
-- которую обновляет приём тревог. Выдумка выглядела свежей проверкой.
--
-- Ноль вне шкалы 1-5, поэтому обнуление в NULL не теряет ни одного
-- измерения: измерений нет. Дефолты сняты — новая строка теперь честно
-- молчит, а не сообщает «свободно».
--
-- Идемпотентно. `IF NOT EXISTS` на колонках, CHECK через DO-блок.

ALTER TABLE location_safety_profile
  ADD COLUMN IF NOT EXISTS profile_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS profile_source_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'location_safety_profile_source_known'
  ) THEN
    ALTER TABLE location_safety_profile
      ADD CONSTRAINT location_safety_profile_source_known
      CHECK (profile_source IS NULL OR profile_source IN ('type_template', 'manual', 'unknown'));
  END IF;
END $$;

COMMENT ON COLUMN location_safety_profile.profile_source IS
  'Откуда строка: type_template (выведено из location_type миграцией 070/0645, не измерено), manual (записал человек), unknown (не установлено). Пишет тот, кто меняет значения.';

-- Отпечаток шаблона. Тип и вид активности берём там же, где их брал 070 —
-- в agent_route_knowledge (VIEW над places и kamchatka_routes).
WITH k AS (
  SELECT id, location_type, activity_type FROM agent_route_knowledge
),
judged AS (
  SELECT
    lsp.agent_route_id,
    (
      -- Вариант 070
      (
        lsp.capacity_per_day = CASE k.location_type
                                 WHEN 'volcano' THEN 30
                                 WHEN 'hot_spring' THEN 100
                                 WHEN 'geyser' THEN 80
                                 ELSE 50 END
        AND lsp.optimal_group_size = CASE WHEN k.location_type = 'volcano' THEN 6 ELSE 8 END
        AND lsp.difficulty_level = CASE
                                     WHEN k.activity_type = 'helicopter' THEN 4
                                     WHEN k.location_type = 'volcano' THEN 4
                                     WHEN k.activity_type = 'boat_trip' THEN 2
                                     ELSE 2 END
        AND lsp.terrain_type = CASE
                                 WHEN k.location_type = 'volcano' THEN 'mountain'
                                 WHEN k.location_type = 'hot_spring' THEN 'thermal'
                                 WHEN k.location_type IN ('bay', 'river') THEN 'water'
                                 ELSE 'forest' END
        AND lsp.hazard_types = CASE
                                 WHEN k.location_type = 'volcano' THEN ARRAY['avalanche','rockfall','thermal','altitude']::TEXT[]
                                 WHEN k.location_type = 'hot_spring' THEN ARRAY['thermal','chemical']::TEXT[]
                                 WHEN k.location_type = 'river' THEN ARRAY['water','rapids']::TEXT[]
                                 ELSE ARRAY['wildlife','weather']::TEXT[] END
      )
      OR
      -- Вариант 0645: те же поля, плюс ветки рыбалки
      (
        lsp.capacity_per_day = CASE
                                 WHEN k.location_type = 'volcano' THEN 30
                                 WHEN k.location_type = 'hot_spring' THEN 100
                                 WHEN k.location_type = 'geyser' THEN 80
                                 WHEN k.activity_type = 'fishing' THEN 20
                                 ELSE 50 END
        AND lsp.optimal_group_size = CASE
                                       WHEN k.location_type = 'volcano' THEN 6
                                       WHEN k.activity_type = 'fishing' THEN 4
                                       ELSE 8 END
        AND lsp.difficulty_level = CASE
                                     WHEN k.activity_type = 'helicopter' THEN 4
                                     WHEN k.location_type = 'volcano' THEN 4
                                     WHEN k.activity_type = 'boat_trip' THEN 2
                                     ELSE 2 END
        AND lsp.terrain_type = CASE
                                 WHEN k.location_type = 'volcano' THEN 'mountain'
                                 WHEN k.location_type = 'hot_spring' THEN 'thermal'
                                 WHEN k.location_type IN ('bay', 'river') THEN 'water'
                                 ELSE 'forest' END
        AND lsp.hazard_types = CASE
                                 WHEN k.location_type = 'volcano' THEN ARRAY['avalanche','rockfall','thermal','altitude']::TEXT[]
                                 WHEN k.location_type = 'hot_spring' THEN ARRAY['thermal','chemical']::TEXT[]
                                 WHEN k.location_type = 'river' THEN ARRAY['water','rapids']::TEXT[]
                                 ELSE ARRAY['wildlife','weather']::TEXT[] END
      )
    ) AS is_template
  FROM location_safety_profile lsp
  JOIN k ON k.id = lsp.agent_route_id
)
UPDATE location_safety_profile lsp
   SET profile_source = CASE WHEN j.is_template THEN 'type_template' ELSE 'unknown' END,
       profile_source_at = NOW()
  FROM judged j
 WHERE j.agent_route_id = lsp.agent_route_id
   AND lsp.profile_source IS NULL;

-- Строки без записи в agent_route_knowledge остались без источника: сказать о
-- них нечего, и выдумывать 'unknown' от имени несуществующего места незачем —
-- перепись покажет их отдельной строкой.

-- Загрузка и счётчики: ноль был дефолтом, а не измерением.
ALTER TABLE location_real_time_status ALTER COLUMN current_crowds DROP DEFAULT;
ALTER TABLE location_real_time_status ALTER COLUMN tourists_today DROP DEFAULT;
ALTER TABLE location_real_time_status ALTER COLUMN tourists_hour DROP DEFAULT;

-- Вне шкалы 1-5 значение не может прочитать даже единственный читатель: он
-- отвечает «Переполнено» на всё, что больше четырёх. Производителя у колонки
-- нет (проверено grep по всему репозиторию), то есть осмысленное число сюда
-- записать было нечем — обнуляем всё, что шкале не принадлежит, включая
-- дефолтный ноль. Измерений при этом не теряется: их не существует.
UPDATE location_real_time_status
   SET current_crowds = NULL
 WHERE current_crowds IS NOT NULL AND current_crowds NOT BETWEEN 1 AND 5;
UPDATE location_real_time_status SET tourists_today = NULL WHERE tourists_today = 0;
UPDATE location_real_time_status SET tourists_hour = NULL WHERE tourists_hour = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'location_real_time_status_crowds_scale'
  ) THEN
    ALTER TABLE location_real_time_status
      ADD CONSTRAINT location_real_time_status_crowds_scale
      CHECK (current_crowds IS NULL OR current_crowds BETWEEN 1 AND 5);
  END IF;
END $$;

COMMENT ON COLUMN location_real_time_status.current_crowds IS
  'Загрузка места по шкале 1-5 (1 свободно, 5 переполнено). NULL — не измеряли. Производителя в платформе пока нет: до миграции 1032 у всех строк стоял DEFAULT 0, и карточка показывала его зелёным «Свободно».';
