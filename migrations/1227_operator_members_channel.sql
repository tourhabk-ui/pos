-- Migration 1227: мессенджер менеджера команды оператора (CRM 2г-4)
-- Created: 2026-10-13
--
-- Решение владельца 11.10: уведомления о новых бронях и заявках — и
-- менеджерам. Чат кабинета (partners.max_chat_id / telegram_chat_id) один на
-- партнёра: второй чат его перезаписал бы и увёл заявки владельца. Поэтому у
-- менеджера свой адрес — в его строке команды. Пишет его только ссылка,
-- которую менеджер берёт в своём кабинете (lib/operators/member-channel),
-- читает — рассылка команде (lib/operators/team-notify), стирает — снятие из
-- команды (lib/operators/team, revokeMember).
--
-- Колонки пустые у всех: адрес появляется только когда менеджер сам нажмёт
-- «Старт» в боте. Идемпотентно (ADD COLUMN IF NOT EXISTS).

BEGIN;

ALTER TABLE operator_members ADD COLUMN IF NOT EXISTS max_chat_id BIGINT;
ALTER TABLE operator_members ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE operator_members ADD COLUMN IF NOT EXISTS channel_bound_at TIMESTAMPTZ;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE operator_members DROP COLUMN IF EXISTS channel_bound_at;
-- ALTER TABLE operator_members DROP COLUMN IF EXISTS telegram_chat_id;
-- ALTER TABLE operator_members DROP COLUMN IF EXISTS max_chat_id;
-- COMMIT;
