-- Migration 1353: кабинет в чате — время сводки и счёт пользования
-- Created: 2026-10-30
--
-- Слово владельца 30.10 (после кабинета в чате, 1351): «если ещё продумать» —
-- «сводка: время и выключить», «счёт: пользуются ли», «менеджеры оператора»,
-- «пилот с оператором». Новых таблиц две; менеджерам своей не нужно — их
-- чат уже записан в operator_members (1230).
--
-- 1. chat_cabinet_settings — когда партнёру приходит сводка кабинета в чате
--    (lib/chat-cabinet/digest): утром (с 08:00), днём (с 13:00), вечером
--    (с 18:00) по Камчатке или никогда. Строки нет — утром, как было до
--    этой миграции: молчание строки не выключает сводку тому, кто её не
--    трогал. Меняет партнёр кнопкой «Сводка» в «Ещё» своего чата.
--
-- 2. chat_cabinet_usage — сколько раз нажимали кабинет: день по Камчатке,
--    карточка, кто (владелец чата карточки или менеджер команды), канал,
--    действие и исход. Только счётчик: ни текста, ни чата, ни человека —
--    по нему видно, пользуются ли кабинетом, а не кто что искал.
--
-- Идемпотентно: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS chat_cabinet_settings (
  partner_id  UUID        PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  digest      TEXT        NOT NULL DEFAULT 'morning',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chat_cabinet_settings_digest_check CHECK (digest IN ('morning', 'day', 'evening', 'off'))
);

COMMENT ON TABLE chat_cabinet_settings IS
  'Кабинет в чате (1353): когда приходит сводка — morning (с 08:00), day (с 13:00), evening (с 18:00) по Камчатке или off. Строки нет — morning.';

CREATE TABLE IF NOT EXISTS chat_cabinet_usage (
  day         DATE    NOT NULL,
  partner_id  UUID    NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  seat        TEXT    NOT NULL,
  channel     TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,
  n           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, partner_id, seat, channel, action, outcome),
  CONSTRAINT chat_cabinet_usage_seat_check CHECK (seat IN ('owner', 'member')),
  CONSTRAINT chat_cabinet_usage_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT chat_cabinet_usage_action_check CHECK (action ~ '^[a-z_]{2,32}$'),
  CONSTRAINT chat_cabinet_usage_outcome_check CHECK (outcome IN ('ok', 'failed')),
  CONSTRAINT chat_cabinet_usage_n_check CHECK (n > 0)
);

COMMENT ON TABLE chat_cabinet_usage IS
  'Кабинет в чате (1353): счётчик нажатий по камчатскому дню, карточке, месту (owner — чат карточки, member — менеджер команды), каналу, действию и исходу. Без текста, чата и человека.';
COMMENT ON COLUMN chat_cabinet_usage.day IS
  'Камчатская дата нажатия (UTC+12), а не дата сервера.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS chat_cabinet_usage;
-- DROP TABLE IF EXISTS chat_cabinet_settings;
-- COMMIT;
