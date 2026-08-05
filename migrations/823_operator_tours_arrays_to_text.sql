-- Migration 823: привести included/not_included/what_to_bring к TEXT[]
--
-- ФАКТ, а не гипотеза. Владелец 05.08 нажал «Сохранить» на туре и получил от
-- базы: «invalid input syntax for type json». Это ответ Postgres на попытку
-- положить в json-колонку литерал массива `{a,b,c}` — именно так драйвер
-- сериализует JS-массив. Значит на проде эти три колонки имеют тип json, а
-- репозиторий с миграции 056 считает их TEXT[].
--
-- Отсюда всё остальное. Миграции 796, 806 и 819 писали `ARRAY[...]` — для
-- json-колонки это ошибка типа, и все три падали. Падали МОЛЧА: причина лежала
-- в _migration_failures, куда никто не смотрел, а на карточке просто оставался
-- старый демо-состав. Три дня разбирательств и три догадки подряд — отсюда.
--
-- Почему 056 не сработала: она добавляет колонки через
-- `ADD COLUMN IF NOT EXISTS ... TEXT[]`, а они уже существовали как json. Такой
-- ADD молча ничего не делает — расхождение типов родилось бесшумно и жило год.
--
-- Приводим прод к тому, что объявляет репозиторий, а не наоборот. Иначе у
-- каждого, кто напишет `included = ARRAY[...]`, миграция снова упадёт молча.
--
-- Вью пересоздаются автоматически. Их имена НЕ вписаны в код: список вью,
-- зависящих от operator_tours, меняется, а вписанный руками список устаревает
-- молча — сегодня это уже стоило нам сломанной диагностики. Определения
-- снимаются через pg_get_viewdef, вью удаляются от самых зависимых к базовым и
-- восстанавливаются в обратном порядке.
--
-- Идемпотентна: если колонки уже TEXT[], миграция не делает ничего.

DO $$
DECLARE
  v_needed   BOOLEAN;
  v_saved    JSONB := '[]'::jsonb;
  v_row      RECORD;
  v_col      TEXT;
  v_item     JSONB;
BEGIN
  -- Нужна ли работа вообще.
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'operator_tours'
       AND column_name IN ('included', 'not_included', 'what_to_bring')
       AND udt_name IN ('json', 'jsonb')
  ) INTO v_needed;

  IF NOT v_needed THEN
    RAISE NOTICE 'Колонки уже TEXT[] — нечего приводить.';
    RETURN;
  END IF;

  -- 1. Запоминаем зависимые вью вместе с глубиной зависимости.
  FOR v_row IN
    WITH RECURSIVE deps AS (
      SELECT DISTINCT c.oid AS view_oid, 0 AS depth
        FROM pg_class c
        JOIN pg_rewrite r ON r.ev_class = c.oid
        JOIN pg_depend  d ON d.objid = r.oid
       WHERE c.relkind = 'v'
         AND d.refobjid = 'public.operator_tours'::regclass
      UNION ALL
      SELECT c.oid, deps.depth + 1
        FROM deps
        JOIN pg_depend  d ON d.refobjid = deps.view_oid
        JOIN pg_rewrite r ON r.oid = d.objid
        JOIN pg_class   c ON c.oid = r.ev_class
       WHERE c.relkind = 'v'
         AND c.oid <> deps.view_oid
         AND deps.depth < 10
    )
    SELECT view_oid::regclass::text AS view_name,
           MAX(depth)               AS depth,
           pg_get_viewdef(view_oid, true) AS definition
      FROM deps
     GROUP BY view_oid
     ORDER BY MAX(depth) DESC
  LOOP
    v_saved := v_saved || jsonb_build_object(
      'name', v_row.view_name,
      'depth', v_row.depth,
      'definition', v_row.definition
    );
  END LOOP;

  -- 2. Сносим вью — от самых зависимых к базовым.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_saved) LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s CASCADE', v_item->>'name');
  END LOOP;

  -- 3. Меняем тип. DEFAULT снимаем: старый ('[]'::json) к TEXT[] не приводится.
  FOREACH v_col IN ARRAY ARRAY['included', 'not_included', 'what_to_bring'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'operator_tours'
         AND column_name = v_col AND udt_name IN ('json', 'jsonb')
    ) THEN
      EXECUTE format('ALTER TABLE operator_tours ALTER COLUMN %I DROP DEFAULT', v_col);
      EXECUTE format($f$
        ALTER TABLE operator_tours
        ALTER COLUMN %I TYPE TEXT[]
        USING CASE
          WHEN %I IS NULL THEN NULL
          WHEN jsonb_typeof(%I::jsonb) = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(%I::jsonb))
          ELSE ARRAY[]::text[]
        END
      $f$, v_col, v_col, v_col, v_col);
    END IF;
  END LOOP;

  -- 4. Возвращаем вью — от базовых к зависимым.
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_saved)
     ORDER BY (value->>'depth')::int ASC
  LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %s AS %s',
                   v_item->>'name', v_item->>'definition');
  END LOOP;

  RAISE NOTICE 'Колонки приведены к TEXT[], вью восстановлены: %',
               jsonb_array_length(v_saved);
END $$;
