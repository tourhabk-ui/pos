-- Migration 676: Fix smart_notifications_log.user_id type
-- users.id is UUID; migration 125 declared the column as INTEGER, so every
-- INSERT from /api/cron/smart-notify would fail on the type.
--
-- Правка 28.07: миграция не применялась ни разу, и аудит боевой схемы показал
-- почему — таблицы `smart_notifications_log` в проде НЕТ ВООБЩЕ, хотя
-- создающая её миграция 125 числится применённой. Это отдельный факт, который
-- стоит записать: в `_migrations` есть строки о миграциях, которые в
-- действительности не выполнялись (следствие разового бутстрапа учёта на
-- готовой базе). Поэтому ALTER TABLE без таблицы ронял файл на каждом деплое,
-- а крон уведомлений молча ничего не писал.
--
-- Теперь миграция самодостаточна: таблицы нет — создаём сразу с UUID; таблица
-- есть со старым INTEGER — чиним тип. Идемпотентна в обоих случаях.

DO $$
BEGIN
  IF to_regclass('public.smart_notifications_log') IS NULL THEN
    CREATE TABLE smart_notifications_log (
      id            BIGSERIAL PRIMARY KEY,
      user_id       UUID NOT NULL,
      tours_matched BIGINT[] NOT NULL DEFAULT '{}',
      channel       VARCHAR(20) NOT NULL DEFAULT 'telegram',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'smart_notifications_log'
       AND column_name = 'user_id'
       AND data_type <> 'uuid'
  ) THEN
    -- INTEGER непереводим в UUID, но осмысленных строк там быть не могло:
    -- INSERT'ы падали на типе с самого начала.
    ALTER TABLE smart_notifications_log DROP COLUMN user_id;
    ALTER TABLE smart_notifications_log ADD COLUMN user_id UUID NOT NULL DEFAULT gen_random_uuid();
    ALTER TABLE smart_notifications_log ALTER COLUMN user_id DROP DEFAULT;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_smart_notify_user_time;

CREATE INDEX IF NOT EXISTS idx_smart_notify_user_time
  ON smart_notifications_log(user_id, created_at DESC);
