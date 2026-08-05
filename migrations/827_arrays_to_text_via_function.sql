-- Migration 827: привести колонки-массивы к TEXT[] — без подзапроса в USING
--
-- 823 и 826 написаны с ошибкой, и Watchdog назвал её точно:
--
--     cannot use subquery in transform expression
--
-- В `ALTER COLUMN ... TYPE ... USING <выражение>` Postgres запрещает подзапрос,
-- а я написал туда `ARRAY(SELECT jsonb_array_elements_text(...))`. Обе миграции
-- упали, колонки остались jsonb, 824 упала следом по той же причине, по которой
-- падали 796 и 819: `COALESCE types jsonb and text[] cannot be matched`.
--
-- Важное следствие, которое я сначала прочитал неверно: состав тура в базе НЕ
-- изменился. На скриншоте кабинета были видны правки владельца в форме, а не
-- сохранённые данные — сохранение падало, форма показывала набранное.
--
-- Обход прямой: вызов функции подзапросом не считается. Заводим временную
-- функцию преобразования, приводим типы, функцию убираем. Тело функции
-- подзапрос содержать может — ограничение касается только выражения USING.
--
-- Охват — все колонки, объявленные массивами текста (040 завела tags, 056 —
-- included/not_included/what_to_bring и photos, 809 — safety_notes), и только
-- те из них, что фактически json. `program` не трогаем: там массив объектов
-- {title, text}, это настоящий JSON.
--
-- Зависимые вью снимаются и восстанавливаются по pg_get_viewdef — их имена не
-- вписаны, вписанный список устаревает молча.
--
-- Идемпотентна: если все колонки уже TEXT[], миграция не делает ничего.

CREATE OR REPLACE FUNCTION _jsonb_to_text_array(v jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v))
    ELSE ARRAY[]::text[]
  END
$fn$;

DO $$
DECLARE
  v_cols    TEXT[] := ARRAY[
    'included', 'not_included', 'what_to_bring', 'photos', 'safety_notes', 'tags'
  ];
  v_pending TEXT[];
  v_saved   JSONB := '[]'::jsonb;
  v_row     RECORD;
  v_col     TEXT;
  v_item    JSONB;
BEGIN
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

  -- 1. Запомнить зависимые вью с глубиной зависимости.
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
    SELECT view_oid::regclass::text       AS view_name,
           MAX(depth)                     AS depth,
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

  -- 2. Снести вью — от самых зависимых к базовым.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_saved) LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s CASCADE', v_item->>'name');
  END LOOP;

  -- 3. Сменить тип. В USING — ВЫЗОВ ФУНКЦИИ, а не подзапрос: на этом упала 823.
  --    DEFAULT снимаем: '[]'::json к TEXT[] не приводится.
  FOREACH v_col IN ARRAY v_pending LOOP
    EXECUTE format('ALTER TABLE operator_tours ALTER COLUMN %I DROP DEFAULT', v_col);
    EXECUTE format(
      'ALTER TABLE operator_tours ALTER COLUMN %I TYPE TEXT[] USING _jsonb_to_text_array(%I::jsonb)',
      v_col, v_col
    );
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

DROP FUNCTION IF EXISTS _jsonb_to_text_array(jsonb);
