-- Migration 1387: вход через MAX/Telegram — кабинет на аккаунте-заглушке (03.11)
--
-- 1386 не считала владельцем кабинета никого с почтой-заглушкой
-- (max_%@max.local / tg_%@telegram.local). Но гид/оператор, заведённый
-- подключением бота без почты, живёт именно на такой заглушке — и вход
-- через MAX по-прежнему вёл в пустого туриста (кабинет на TG-аккаунте,
-- MAX-id на пустом туристе). Теперь заглушка — владелец, если у неё роль
-- не tourist или свой кабинет в partners. Пустой турист-дубль владельцем
-- не бывает. Выключается только пустой дубль (vedar_messenger_placeholder_empty
-- из 1386: роль tourist и ни одной строки с данными) — реальные аккаунты
-- не трогаются. Аккаунт без почты (email NULL — заведён командой/админом)
-- тоже владелец: в 1386 NOT(NULL LIKE …) давал NULL и отсекал его. Повторный прогон — без эффекта.

BEGIN;

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
       AND (
         NOT (COALESCE(u.email, '') LIKE 'max\_%@max.local' OR COALESCE(u.email, '') LIKE 'tg\_%@telegram.local')
         OR u.role IS DISTINCT FROM 'tourist'
         OR EXISTS (SELECT 1 FROM partners own WHERE own.user_id::text = u.id::text)
       )
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
    CONTINUE WHEN owner IS NULL OR owner::text = d.id::text;
    IF NOT vedar_messenger_placeholder_empty(d.id) THEN
      RAISE NOTICE '1387: дубль % (%) с данными — пропущен, владелец %', d.id, ch, owner;
      CONTINUE;
    END IF;
    IF ch = 'max' THEN
      IF EXISTS (SELECT 1 FROM users WHERE id = owner AND max_user_id IS NOT NULL) THEN
        RAISE NOTICE '1387: у владельца % уже другой MAX — пропущен дубль %', owner, d.id; CONTINUE;
      END IF;
      UPDATE users SET max_user_id = NULL, is_active = FALSE WHERE id::text = d.id::text;
      UPDATE users SET max_user_id = ext WHERE id = owner;
    ELSE
      IF EXISTS (SELECT 1 FROM users WHERE id = owner AND telegram_id IS NOT NULL) THEN
        RAISE NOTICE '1387: у владельца % уже другой Telegram — пропущен дубль %', owner, d.id; CONTINUE;
      END IF;
      UPDATE users SET telegram_id = NULL, is_active = FALSE WHERE id::text = d.id::text;
      UPDATE users SET telegram_id = ext WHERE id = owner;
    END IF;
    DELETE FROM user_sessions WHERE user_id::text = d.id::text;
    RAISE NOTICE '1387: % перенесён с дубля % на %', ch, d.id, owner;
  END LOOP;
END
$mig$;

COMMIT;
