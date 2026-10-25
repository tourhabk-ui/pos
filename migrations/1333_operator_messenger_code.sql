-- 1333: короткий код привязки мессенджера из кабинета оператора
-- и закрытие тестового тикета поддержки.
--
-- Ссылка /start link_ пишет Telegram в users и читает роль человека.
-- Администратор в «Войти как → Туроператор» получал командный центр,
-- хотя нажимал кнопку в кабинете оператора. Код из шести знаков
-- привязывает чат к карточке партнёра, не к роли пользователя.
--
-- Тикет #686917ae создала кнопка «Помощь» при той проверке.
-- Закрываем его, если он ещё открыт: это проба, не обращение туриста.

BEGIN;

CREATE TABLE IF NOT EXISTS messenger_bind_codes (
  code TEXT PRIMARY KEY,
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  telegram_chat_id BIGINT,
  max_chat_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messenger_bind_codes_code_check CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$')
);

CREATE INDEX IF NOT EXISTS messenger_bind_codes_partner_idx
  ON messenger_bind_codes (partner_id, created_at DESC);

COMMENT ON TABLE messenger_bind_codes IS
  'Код /start из кабинета: чат пишется в карточку партнёра. Не users.telegram_id.';

-- Канал тикета знал telegram/web/email. Обращение из MAX иначе пришлось бы
-- писать как «сайт». Снимаем проверку на колонке channel, как бы она ни
-- называлась, и ставим ту же с max.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
   WHERE nsp.nspname = 'public'
     AND rel.relname = 'support_tickets'
     AND att.attname = 'channel'
     AND con.contype = 'c'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE support_tickets DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_channel_check
  CHECK (channel IN ('telegram', 'web', 'email', 'max'));

UPDATE support_tickets
   SET status = 'closed',
       resolution = 'Тестовое обращение при проверке кабинета оператора. Закрыто без ответа.',
       resolved_at = COALESCE(resolved_at, NOW()),
       updated_at = NOW()
 WHERE id::text LIKE '686917ae-%'
   AND channel = 'telegram'
   AND status <> 'closed';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS messenger_bind_codes;
-- COMMIT;
