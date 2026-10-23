-- 1324: администратор в MAX — одноразовая ссылка подключения и привязка.
--
-- Слово владельца 23.10: «Я админ и чат должен знать что админ подключен со
-- всеми правами»; способ — «1а»: кнопка «Подключить MAX администратора» в
-- админке, одноразовая ссылка на 10 минут, «Старт» в MAX.
--
-- Почему не users.max_user_id: эта колонка — личность «Войти через MAX»
-- (app/api/auth/max/status). Запиши туда MAX администратора — и вход через
-- MAX выдал бы админский токен сайта, о чём владелец не просил; а если этот
-- человек уже входил через MAX туристом, уникальный индекс 799 ответил бы
-- 23505. Поэтому привязка — своя таблица.
--
-- Привязан ЧЕЛОВЕК MAX (max_user_id из заверенного апдейта), а не чат: в
-- личном диалоге MAX id чата и id человека — разные числа, а права решает,
-- кто пишет. max_chat_id — только адрес для ответа.
--
-- Права не хранятся здесь: на каждом сообщении бот заново читает, есть ли у
-- пользователя роль администратора (users.role или preferences.roles), —
-- снятый в админке админ теряет и чат на следующем же сообщении.
--
-- Ссылка: в базе только sha256-хеш ключа (сырой ключ живёт в ссылке, как у
-- password_reset_tokens, 1175). Срок и одноразовость — предикаты UPDATE при
-- погашении, не проверка в коде.

BEGIN;

CREATE TABLE IF NOT EXISTS admin_max_link_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_max_link_tokens_user
  ON admin_max_link_tokens (user_id)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_max_bindings (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_user_id  BIGINT NOT NULL UNIQUE,
  max_chat_id  BIGINT NOT NULL,
  bound_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_max_link_tokens IS
  'Одноразовая ссылка «Подключить MAX администратора»: хеш ключа, срок 10 минут, used_at. Сырой ключ не хранится.';
COMMENT ON TABLE admin_max_bindings IS
  'Какой человек MAX — администратор этого аккаунта. Права каждый раз читаются из users заново.';
COMMENT ON COLUMN admin_max_bindings.max_user_id IS
  'id человека в MAX из заверенного апдейта (не id диалога).';
COMMENT ON COLUMN admin_max_bindings.max_chat_id IS
  'Личный диалог с ботом — только адрес для ответов.';

COMMIT;
