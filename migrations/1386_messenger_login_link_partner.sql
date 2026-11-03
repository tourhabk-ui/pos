-- Migration 1386: вход через MAX/Telegram находит кабинет партнёра (03.11)
--
-- Причина (жалоба оператора 03.11): вход искал только users.max_user_id /
-- users.telegram_id, а подключение бота пишет MAX/Telegram в partners
-- (max_owner_user_id, telegram_chat_id/telegram_owner_user_id) и
-- operator_members (telegram_chat_id). Не найдя — вход создавал пустого
-- туриста max_<id>@max.local / tg_<id>@telegram.local.
--
-- 1) Функции, общие для входа (lib/auth/messenger-link.ts) и этой миграции.
-- 2) Разовый перенос: id с пустого дубля — на единственного владельца
--    кабинета; дубль выключается. Дубль с данными (брони, заявки, сообщения —
--    любая строка в таблице со ссылкой на users, кроме служебных) не
--    трогается и пишется в лог (RAISE NOTICE). Повторный прогон — без эффекта.

BEGIN;

-- Пустой ли дубль: заглушечная почта, роль tourist и ни одной строки в
-- таблицах со ссылкой на users(id), кроме служебных входа/согласий.
CREATE OR REPLACE FUNCTION vedar_messenger_placeholder_empty(uid UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  r RECORD;
  found_row BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id::text = uid::text AND u.role = 'tourist'
       AND (u.email LIKE 'max\_%@max.local' OR u.email LIKE 'tg\_%@telegram.local')
  ) THEN
    RETURN FALSE;
  END IF;
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
       AND array_length(c.conkey, 1) = 1
       AND c.conrelid::regclass::text NOT IN (
         'users', 'user_sessions', 'user_agreements', 'user_consents', 'pd_consents',
         'notifications', 'user_notification_settings', 'refresh_tokens',
         'auth_audit_log', 'login_attempts', 'audit_log', 'audit_logs')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', r.tbl, r.col)
      INTO found_row USING uid;
    IF found_row THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END
$fn$;

-- Единственный владелец кабинета для MAX/Telegram id, иначе NULL.
-- MAX: только max_owner_user_id (chat_id диалога MAX — не id человека).
-- Telegram: chat_id лички равен id человека, поэтому и telegram_chat_id.
-- Пустые дубли-заглушки кандидатами не считаются.
CREATE OR REPLACE FUNCTION vedar_messenger_owner(channel TEXT, ext_id BIGINT)
RETURNS UUID LANGUAGE sql STABLE AS $fn$
  WITH c AS (
    SELECT p.user_id AS uid FROM partners p
     WHERE p.user_id IS NOT NULL AND (
       (channel = 'max' AND p.max_owner_user_id = ext_id) OR
       (channel = 'telegram' AND (p.telegram_owner_user_id = ext_id OR p.telegram_chat_id = ext_id)))
    UNION
    SELECT m.user_id FROM operator_members m
     WHERE m.user_id IS NOT NULL AND m.status = 'active'
       AND channel = 'telegram' AND m.telegram_chat_id = ext_id
  ), real AS (
    SELECT DISTINCT c.uid FROM c JOIN users u ON u.id::text = c.uid::text
     WHERE u.is_active IS NOT FALSE
       AND NOT (u.email LIKE 'max\_%@max.local' OR u.email LIKE 'tg\_%@telegram.local')
  )
  SELECT CASE WHEN (SELECT count(*) FROM real) = 1 THEN (SELECT uid FROM real) END
$fn$;

DO $mig$
DECLARE
  d RECORD;
  owner UUID;
  ch TEXT;
  ext BIGINT;
BEGIN
  FOR d IN
    SELECT id, max_user_id, telegram_id FROM users
     WHERE role = 'tourist'
       AND (email LIKE 'max\_%@max.local' OR email LIKE 'tg\_%@telegram.local')
       AND (max_user_id IS NOT NULL OR telegram_id IS NOT NULL)
  LOOP
    ch := CASE WHEN d.max_user_id IS NOT NULL THEN 'max' ELSE 'telegram' END;
    ext := COALESCE(d.max_user_id, d.telegram_id);
    owner := vedar_messenger_owner(ch, ext);
    CONTINUE WHEN owner IS NULL;
    IF NOT vedar_messenger_placeholder_empty(d.id) THEN
      RAISE NOTICE '1386: дубль % (%) с данными — пропущен, владелец %', d.id, ch, owner;
      CONTINUE;
    END IF;
    IF ch = 'max' THEN
      IF EXISTS (SELECT 1 FROM users WHERE id = owner AND max_user_id IS NOT NULL) THEN
        RAISE NOTICE '1386: у владельца % уже другой MAX — пропущен дубль %', owner, d.id; CONTINUE;
      END IF;
      UPDATE users SET max_user_id = NULL, is_active = FALSE WHERE id::text = d.id::text;
      UPDATE users SET max_user_id = ext WHERE id = owner;
    ELSE
      IF EXISTS (SELECT 1 FROM users WHERE id = owner AND telegram_id IS NOT NULL) THEN
        RAISE NOTICE '1386: у владельца % уже другой Telegram — пропущен дубль %', owner, d.id; CONTINUE;
      END IF;
      UPDATE users SET telegram_id = NULL, is_active = FALSE WHERE id::text = d.id::text;
      UPDATE users SET telegram_id = ext WHERE id = owner;
    END IF;
    DELETE FROM user_sessions WHERE user_id::text = d.id::text;
    RAISE NOTICE '1386: % перенесён с дубля % на %', ch, d.id, owner;
  END LOOP;
END
$mig$;

COMMIT;
