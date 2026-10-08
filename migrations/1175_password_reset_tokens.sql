-- 1175: токены сброса пароля.
--
-- До этой миграции у платформы не было пути «забыл пароль»: шаблон письма
-- passwordResetEmail лежал в email-templates.ts с мая и не вызывался ниоткуда
-- (объявленный исход без производителя, §10.09). Партнёр, заведённый
-- администратором с временным паролем, мог сменить его только зная временный.
--
-- Что хранится: ТОЛЬКО sha256-хеш токена. Сырой токен живёт в ссылке письма и
-- в ответе администратору, в базу не попадает: утечка таблицы не даёт входа.
-- Токен одноразовый (used_at) и срочный (expires_at); оба предиката
-- проверяются в SQL при погашении, не в коде после чтения.
--
-- issued_by: NULL — человек запросил сам через форму; id администратора —
-- ссылку выдали из админки (когда SMTP не настроен или письмо не дошло).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  issued_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

COMMENT ON TABLE password_reset_tokens IS
  'Сброс пароля: хеш токена, срок, одноразовость. Сырой токен не хранится.';
COMMENT ON COLUMN password_reset_tokens.issued_by IS
  'NULL — запросил сам через форму; иначе администратор, выдавший ссылку.';
