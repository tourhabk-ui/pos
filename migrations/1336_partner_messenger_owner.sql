-- Migration 1336: кто открыл ссылку подключения карточки — для входа на сайт через мессенджер
-- Created: 2026-10-26
--
-- Владелец 26.10: прокатчику «Лагуны» нужен кабинет на сайте («где роль
-- прокат», «делай»). Вход на сайт у платформы — по почте с паролем либо через
-- MAX и Telegram; почты у человека нет, мессенджер есть. А чат карточки уже
-- подключён ссылкой op_ из админки (lib/partners/channel-link).
--
-- До этой миграции карточка помнила только ЧАТ (max_chat_id,
-- telegram_chat_id), но не ЧЕЛОВЕКА, нажавшего «Старт» по ссылке: в MAX id
-- диалога и id пользователя — разные числа. Две колонки ниже пишет привязка
-- по ссылке op_ (lib/partners/bind-channel) — только из личного диалога и
-- только по заверенному апдейту. Читает их кнопка администратора «Вход через
-- MAX / Telegram» (POST /api/admin/operators/[id]/messenger-login): она
-- заводит или находит аккаунт с этим max_user_id / telegram_id и делает его
-- владельцем карточки. Дальше человек входит на сайт кнопкой «Войти через
-- MAX» (или Telegram) — пароля и телефона не нужно.
--
-- NULL — по ссылке ещё никто не входил после этой миграции (или чат
-- групповой): кнопка тогда отвечает, что сначала нужно открыть ссылку.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS max_owner_user_id BIGINT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS telegram_owner_user_id BIGINT;

COMMENT ON COLUMN partners.max_owner_user_id IS
  'MAX user_id того, кто открыл ссылку подключения op_ в личном диалоге (1336); для входа на сайт через MAX';
COMMENT ON COLUMN partners.telegram_owner_user_id IS
  'Telegram id того, кто открыл ссылку подключения op_ в личном чате (1336); для входа на сайт через Telegram';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE partners DROP COLUMN IF EXISTS max_owner_user_id;
-- ALTER TABLE partners DROP COLUMN IF EXISTS telegram_owner_user_id;
-- COMMIT;
