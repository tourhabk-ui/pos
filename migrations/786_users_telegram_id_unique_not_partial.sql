-- 786: уникальность users(telegram_id) должна работать на ЧИСТОЙ базе, а не
-- только на проде.
--
-- Аудит боевой схемы 28.07 показал два уникальных индекса по одной колонке:
--   users_telegram_id_key   — существовал до миграции 783, в файлах схемы его
--                             нет: колонку когда-то пометили UNIQUE руками мимо
--                             миграций;
--   uq_users_telegram_id    — создан миграцией 783, ЧАСТИЧНЫЙ
--                             (WHERE telegram_id IS NOT NULL).
--
-- Сначала это выглядело как безобидный дубль. На деле опаснее: вход через
-- Telegram делает `INSERT ... ON CONFLICT (telegram_id)`, а вывести арбитра из
-- ЧАСТИЧНОГО индекса Postgres не может — для этого запрос должен нести
-- совпадающий предикат `ON CONFLICT (col) WHERE ...`. То есть на проде UPSERT
-- работает исключительно за счёт legacy-индекса `users_telegram_id_key`,
-- которого репозиторий не воспроизводит. Подними новый инстанс из миграций — и
-- вход через Telegram упадёт с «no unique or exclusion constraint matching the
-- ON CONFLICT specification». Ровно то, ради чего 783 и писалась.
--
-- Поэтому: полный уникальный индекс вместо частичного. NULL'ы в уникальном
-- индексе Postgres не конфликтуют, так что предикат ничего не давал и без него.
-- Идемпотентно: пересоздаём только если индекс частичный либо его нет вовсе.
-- Дубли (их на 28.07 ноль) не молчим — предупреждаем и оставляем как есть.

DO $$
DECLARE
  dup_count  INT;
  is_partial BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT telegram_id
      FROM users
     WHERE telegram_id IS NOT NULL
     GROUP BY telegram_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING 'uq_users_telegram_id не пересоздан: % дублей telegram_id. Разобрать вручную.', dup_count;
    RETURN;
  END IF;

  SELECT i.indpred IS NOT NULL INTO is_partial
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'uq_users_telegram_id';

  -- is_partial IS NULL — индекса нет вообще (например, 783 не доходила).
  IF is_partial IS NULL OR is_partial THEN
    DROP INDEX IF EXISTS uq_users_telegram_id;
    CREATE UNIQUE INDEX uq_users_telegram_id ON users (telegram_id);
  END IF;
END $$;
