-- Migration 784: объявить колонки, которые используют UPDATE'ы
--
-- Продолжение 783. Там сверялись INSERT'ы, здесь — UPDATE: 202 проверенных
-- выражения, 12 расхождений. Часть повторяет уже известное, но три нашлись
-- впервые, и все три отдают пользователю пятисотку, а не молчат.
--
--   * `users.mfa_secret` / `users.mfa_enabled` — двухфакторная аутентификация.
--     POST /api/auth/mfa/enable пишет секрет и получает 500: включить второй
--     фактор нельзя вообще. Для платформы, где в личном кабинете лежат паспорта
--     туристов и денежные операции операторов, это не мелочь.
--
--   * `users.metadata` — заявка на удаление аккаунта. /api/user/delete пишет
--     туда deletion_requested_at и срок, и тоже падает. Право на удаление
--     персональных данных (152-ФЗ) технически не исполнялось.
--
-- Плюс три колонки `partners`, которые пишут и админка, и кабинет оператора:
-- `contacts` (JSONB, туда кладётся telegram_chat_id — через него Watchdog
-- пишет оператору о зависшей брони), `commission_rate`, `is_available`.
--
-- Типы взяты из фактического использования, не из догадок: `contacts` идёт как
-- `contacts || $1::jsonb`, `metadata` — как `COALESCE(metadata,'{}') ||
-- jsonb_build_object(...)`, `commission_rate` читается как число, остальные
-- как булевы. Всё идемпотентно: на проде no-op, на чистой базе починка.
--
-- ВАЖНО: точный текст выражений с CONCURRENTLY здесь не цитируется. Раннер
-- решает, транзакционная миграция или нет, регуляркой по всему тексту файла —
-- комментарии тоже попадают.

-- ── users: второй фактор и заявка на удаление ────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_secret  TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metadata    JSONB   DEFAULT '{}'::jsonb;

-- ── partners: контакты, комиссия, доступность гида ───────────────────────
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS contacts        JSONB         DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS is_available    BOOLEAN       DEFAULT TRUE;
