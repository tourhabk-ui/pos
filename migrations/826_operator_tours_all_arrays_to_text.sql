-- Migration 826: привести к TEXT[] ВСЕ колонки-массивы operator_tours
--
-- 823 привела три колонки состава — и данные починились: снасти встали в
-- «включено», аренда ушла. Но «Сохранить» в кабинете по-прежнему падает с
-- «invalid input syntax for type json». Значит разошлась не только тройка:
-- в форму входят и другие колонки, и хотя бы одна из них тоже json.
--
-- Угадывать по одной, какая именно, — это и есть круг, на который владелец
-- справедливо указал: правка, деплой, проверка, снова правка. Поэтому здесь
-- не список подозреваемых, а ВСЕ колонки, которые репозиторий объявляет
-- массивами текста: 040 завела tags, 056 — included/not_included/what_to_bring
-- и photos, 809 — safety_notes. Что из них разошлось на проде — миграции
-- всё равно, она смотрит на фактический тип каждой.
--
-- program (JSONB) намеренно НЕ трогаем: это настоящий JSON — массив объектов
-- {title, text}, и там jsonb стоит по делу.
--
-- Логика та же, что в 823: снять зависимые вью по pg_get_viewdef, сменить тип
-- с переносом содержимого, вернуть вью. Имена вью не вписаны — вписанный
-- список устаревает молча.
--
-- Идемпотентна: колонки, уже приведённые 823, пропускаются.

DO $$
DECLARE
  v_cols     TEXT[] := ARRAY[
    'included', 'not_included', 'what_to_bring', 'photos', 'safety_notes', 'tags'
  ];
  v_pending  TEXT[];
  v_saved    JSONB := '[]'::jsonb;
  v_row      RECORD;
  v_col      TEXT;
  v_item     JSONB;
BEGIN
  -- Какие из объявленных массивами колонок на самом деле json.
  SELECT COALESCE(array_agg(column_name::text), ARRAY[]::text[])
    INTO v_pending
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'operator_tours'
     AND column_name  = ANY(v_cols)
     AND udt_name IN ('json', 'jsonb');

  IF array_length(v_pending, 1) IS NULL THEN
    RAISE NOTICE 'Все колонки-массивы уже TEXT[] — нечего приводить.';
    RETURN;
  END IF;

  RAISE NOTICE 'К приведению: %', v_pending;

  -- 1. Запомнить зависимые вью вместе с глубиной зависимости.
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
    SELECT view_oid::regclass::text        AS view_name,
           MAX(depth)                      AS depth,
           pg_get_viewdef(view_oid, true)  AS definition
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

  -- 2. Снести вью — от самых зависимых к базовым.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_saved) LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s CASCADE', v_item->>'name');
  END LOOP;

  -- 3. Сменить тип. DEFAULT снимаем: '[]'::json к TEXT[] не приводится.
  FOREACH v_col IN ARRAY v_pending LOOP
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
  END LOOP;

  -- 4. Вернуть вью — от базовых к зависимым.
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_saved)
     ORDER BY (value->>'depth')::int ASC
  LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %s AS %s',
                   v_item->>'name', v_item->>'definition');
  END LOOP;

  RAISE NOTICE 'Приведено колонок: %, восстановлено вью: %',
               array_length(v_pending, 1), jsonb_array_length(v_saved);
END $$;
