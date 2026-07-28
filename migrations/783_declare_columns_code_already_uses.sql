-- Migration 783: объявить колонки, которые код уже использует
--
-- Найдено сверкой INSERT'ов в коде с объявленной схемой (lib/database/schema.sql
-- + migrations/). Ряд колонок код пишет и читает годами, но не объявляет НИ ОДИН
-- файл схемы. На проде они есть — значит их когда-то добавили руками мимо
-- миграций, что CLAUDE.md прямо запрещает.
--
-- Цена этого не теоретическая. Миграция 080 строит индекс по users(telegram_id):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_telegram_id
--     ON users(telegram_id) WHERE telegram_id IS NOT NULL;
--
-- На чистой базе цепочка падает здесь: колонки нет. То есть репозиторий не может
-- собрать собственную БД, а на проде миграция прошла лишь потому, что колонка
-- уже была добавлена вне цепочки. Пока это так, любой новый инстанс — сломанный,
-- а «миграции применяются автоматически при деплое» даёт ложное спокойствие.
--
-- Здесь мы объявляем то, что прод уже имеет. Все операции идемпотентны:
-- на проде это no-op, на чистой базе — починка. Определения продублированы в
-- lib/database/schema.sql, чтобы новый инстанс доходил до миграции 080 живым.

-- ── users: телеграм-вход и согласие на обработку ПД (152-ФЗ) ──────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS telegram_id       BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_active         BOOLEAN     DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS pd_consent_given  BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pd_consent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pd_consent_ip     VARCHAR(64);

-- Вход через Telegram делает UPSERT с `ON CONFLICT (telegram_id)`, а это требует
-- УНИКАЛЬНОГО ограничения — обычного индекса из миграции 080 недостаточно
-- (PostgreSQL: «no unique or exclusion constraint matching the ON CONFLICT
-- specification»). Без него вход через Telegram падал бы даже там, где колонка
-- есть. Частичный уникальный индекс: NULL у обычных пользователей не мешает.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_telegram_id
  ON users (telegram_id) WHERE telegram_id IS NOT NULL;

-- ── chat_sessions: память разговора Кузьмича ─────────────────────────────
-- Веб-чат пишет и читает эти три колонки: счётчик реплик (по нему решается,
-- пора ли предлагать регистрацию), признак авторизованного собеседника и
-- зашифрованные интересы. Ни одно из двух объявлений chat_sessions
-- (lib/database/schema.sql и migrations/03_vector_search.sql) их не содержит, а
-- запись обёрнута в `catch {}` с пометкой «non-critical» — то есть провал
-- молчал, и Кузьмич просто не помнил разговор.
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS user_message_count  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_authenticated    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS interests_encrypted TEXT;
