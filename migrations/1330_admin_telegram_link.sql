-- 1330: администратор в Telegram — одноразовая ссылка подключения и привязка.
--
-- Слово владельца 24.10: «нет привязки админа к Telegram». Рядом с блоком
-- MAX администратора (1324) — та же дверь в Telegram: кнопка в админке,
-- одноразовая ссылка на 10 минут, «Старт» в боте.
--
-- Почему не users.telegram_id: эта колонка — личность «привязать аккаунт»
-- (уникальный индекс 783, /start link_). Запиши туда Telegram администратора —
-- и вход или чужая привязка столкнулись бы с ним на 23505, а права кабинета
-- смешались бы с логином. Поэтому привязка — своя таблица, как у MAX.
--
-- Привязан ЧЕЛОВЕК Telegram (from.id заверенного апдейта личного чата), а не
-- чат: права решает, кто пишет. Чат не хранится: бот отвечает в тот, откуда
-- пришло сообщение.
--
-- Права не хранятся здесь: на каждом сообщении бот заново читает, есть ли у
-- пользователя роль администратора (users.role или preferences.roles).
--
-- Ссылка: префикс adt_ (не adm_ — чужая ссылка MAX здесь не гасится). В базе
-- только sha256-хеш ключа. Срок и одноразовость — предикаты UPDATE при
-- погашении.

BEGIN;

CREATE TABLE IF NOT EXISTS admin_tg_link_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_link_tokens_user
  ON admin_tg_link_tokens (user_id)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_tg_bindings (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id  BIGINT NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  bound_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_tg_link_tokens IS
  'Одноразовая ссылка «Подключить Telegram администратора»: хеш ключа, срок 10 минут, used_at. Сырой ключ не хранится.';
COMMENT ON TABLE admin_tg_bindings IS
  'Какой человек Telegram — администратор этого аккаунта. Права каждый раз читаются из users заново.';
COMMENT ON COLUMN admin_tg_bindings.telegram_user_id IS
  'from.id человека в личном чате (не id группы).';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS admin_tg_bindings;
-- DROP TABLE IF EXISTS admin_tg_link_tokens;
-- COMMIT;
