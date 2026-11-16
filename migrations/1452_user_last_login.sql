-- Migration 1452: отметка последнего входа — чтобы срок профиля стал считаемым
-- Created: 2026-11-16
--
-- #3388 п.2 (слово владельца 16.11 «карт-бланш»). Политика обещает хранить
-- данные профиля «до удаления учётной записи или 3 лет с момента последней
-- активности». Поля последней активности в users нет, и перепись сроков
-- (lib/legal/retention-census.ts) называла этот срок «посчитать нечем».
-- Строки user_sessions его не заменяют: выход, смена пароля и смена роли их
-- удаляют.
--
-- Что здесь:
--  - user_last_login — один ряд на аккаунт: когда он последний раз входил;
--  - триггер на вставку сессии пишет отметку сам. Сессию пишут семь дверей
--    (пароль, регистрация, ссылка на почту, MAX, Telegram, второй фактор,
--    смена роли), и ни одна из них не меняется;
--  - отметка в отдельной таблице, а не колонкой users: вход не трогает
--    users.updated_at (его показывает админка как время правки профиля);
--  - у user_sessions свой внешний ключ на users: сессия без аккаунта не
--    вставится раньше триггера, и ключ отметки вход не уронит;
--  - прошлое восстановлено по сохранившимся сессиям; где их нет — отметки
--    нет, и представление берёт дату регистрации;
--  - v_user_last_activity — последняя известная активность: позднее из
--    регистрации и последнего входа. Это нижняя граница: работа в чате
--    кабинета (MAX, Telegram) входом не отмечается.
--
-- Удаление аккаунта (lib/account/erase.ts) ряд не трогает: в нём нет данных
-- человека, только время, а строка users остаётся обезличенной.

BEGIN;

CREATE TABLE IF NOT EXISTS user_last_login (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_login_at  TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION user_last_login_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    INSERT INTO user_last_login (user_id, last_login_at)
    VALUES (NEW.user_id, COALESCE(NEW.created_at, NOW()))
    ON CONFLICT (user_id) DO UPDATE
      SET last_login_at = GREATEST(user_last_login.last_login_at, EXCLUDED.last_login_at);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS user_sessions_touch_last_login ON user_sessions;
CREATE TRIGGER user_sessions_touch_last_login
  AFTER INSERT ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION user_last_login_touch();

INSERT INTO user_last_login (user_id, last_login_at)
SELECT s.user_id, MAX(s.created_at)
  FROM user_sessions s
 WHERE s.user_id IS NOT NULL AND s.created_at IS NOT NULL
 GROUP BY s.user_id
ON CONFLICT (user_id) DO UPDATE
  SET last_login_at = GREATEST(user_last_login.last_login_at, EXCLUDED.last_login_at);

CREATE OR REPLACE VIEW v_user_last_activity AS
SELECT u.id AS user_id,
       GREATEST(u.created_at, l.last_login_at) AS last_activity_at
  FROM users u
  LEFT JOIN user_last_login l ON l.user_id::text = u.id::text;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP VIEW IF EXISTS v_user_last_activity;
-- DROP TRIGGER IF EXISTS user_sessions_touch_last_login ON user_sessions;
-- DROP FUNCTION IF EXISTS user_last_login_touch();
-- DROP TABLE IF EXISTS user_last_login;
-- COMMIT;
