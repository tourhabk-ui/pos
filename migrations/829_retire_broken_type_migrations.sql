-- Migration 829: снять с повтора 823, 824 и 826 — заменены на 827 и 828
--
-- 823 и 826 содержат ошибку, которую не исправить повтором: в
-- `ALTER COLUMN ... TYPE ... USING` я написал подзапрос
-- `ARRAY(SELECT jsonb_array_elements_text(...))`, а Postgres это запрещает —
-- «cannot use subquery in transform expression». Сколько ни повторяй, результат
-- один. 824 падала следом («COALESCE types jsonb and text[] cannot be
-- matched»), потому что колонки оставались jsonb.
--
-- Их работу делают 827 (тот же смысл, но преобразование вынесено в функцию —
-- вызов функции подзапросом не считается) и 828 (тот же состав тура).
--
-- Файлы остаются в репозитории: они история сегодняшнего дня, и ошибка в них
-- поучительнее, чем их отсутствие. Но повторять их каждый деплой незачем —
-- иначе алерт снова станет постоянно красным, а сторож, который всегда красный,
-- перестают читать. Ровно это уже случилось с 796/800/806/819.
--
-- Идемпотентна.

INSERT INTO _migrations (name)
VALUES
  ('823_operator_tours_arrays_to_text.sql'),
  ('824_bystraya_tackle_free.sql'),
  ('826_operator_tours_all_arrays_to_text.sql')
ON CONFLICT (name) DO NOTHING;

DELETE FROM _migration_failures
 WHERE name IN (
   '823_operator_tours_arrays_to_text.sql',
   '824_bystraya_tackle_free.sql',
   '826_operator_tours_all_arrays_to_text.sql'
 );
