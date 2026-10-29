-- Migration 1351: кабинет в чате — поиск клиента и утренняя сводка
-- Created: 2026-10-30
--
-- Слово владельца 30.10: «продумай app для мессенджеров лёгкий, лучше
-- кнопки в чате», объём — «всё сразу + Telegram». Кабинет партнёра в MAX и
-- Telegram — кнопками: «Входящие», «Задачи», «Клиенты», «Ещё»
-- (lib/chat-cabinet). Почти всё в нём — чтение и запись тех же таблиц CRM,
-- что кабинет на сайте. Новых таблиц две.
--
-- 1. chat_cabinet_waits — после кнопки «Найти клиента» следующее сообщение
--    этого чата — запрос поиска, а не вопрос помощнику. Одно ожидание на чат
--    (частичный UNIQUE), срок 10 минут. Только MAX: поиск отвечает именами
--    клиентов, а им место только в MAX (решение владельца 23.08); у Telegram
--    кнопки поиска нет, и ожиданий с него не бывает. Текст запроса здесь не
--    хранится — только то, что чат ждёт.
--    Последняя кнопка главная: кнопка поиска гасит ожидание причины отказа
--    брони (partner_chat_actions) и сообщения по заявке (request_chat_waits)
--    этого чата, а поиск уступает им, если их кнопку нажали позже
--    (lib/chat-cabinet/service).
--
-- 2. crm_chat_digests — утренняя сводка кабинета: раз в камчатские сутки на
--    партнёра, после 08:00 по Камчатке (крон crm-reminders). Строка — замок
--    «сегодня уже было»: `sending` ставится до отправки и снимается при
--    отказе, итог — max / telegram / empty (ждать нечего, сводка не нужна) /
--    unreachable (адреса нет). Чисел в строке нет: что было в сводке, она не
--    повторяет.
--
-- Идемпотентно: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS chat_cabinet_waits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     TEXT        NOT NULL,
  chat_id     BIGINT      NOT NULL,
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  purpose     TEXT        NOT NULL DEFAULT 'client_search',
  status      TEXT        NOT NULL DEFAULT 'waiting',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  CONSTRAINT chat_cabinet_waits_channel_check CHECK (channel IN ('max')),
  CONSTRAINT chat_cabinet_waits_purpose_check CHECK (purpose IN ('client_search')),
  CONSTRAINT chat_cabinet_waits_status_check CHECK (status IN ('waiting', 'used', 'cancelled', 'superseded')),
  CONSTRAINT chat_cabinet_waits_used_check CHECK ((used_at IS NOT NULL) = (status = 'used'))
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_cabinet_waits_one_per_chat
  ON chat_cabinet_waits (channel, chat_id) WHERE status = 'waiting';

COMMENT ON TABLE chat_cabinet_waits IS
  'Кабинет в чате (1351): чат ждёт запрос поиска клиента после кнопки «Найти клиента». Только MAX, срок 10 минут, одно ожидание на чат. Текст запроса не хранится.';

CREATE TABLE IF NOT EXISTS crm_chat_digests (
  partner_id   UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  digest_date  DATE        NOT NULL,
  channel      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partner_id, digest_date),
  CONSTRAINT crm_chat_digests_channel_check
    CHECK (channel IN ('sending', 'max', 'telegram', 'empty', 'unreachable'))
);

COMMENT ON TABLE crm_chat_digests IS
  'Утренняя сводка кабинета в чате (1351): одна строка на партнёра и камчатскую дату. sending — отправка идёт (снимается при отказе); max / telegram — куда ушла; empty — ждать нечего; unreachable — адреса нет.';
COMMENT ON COLUMN crm_chat_digests.digest_date IS
  'Камчатская дата сводки (UTC+12), а не дата сервера.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS crm_chat_digests;
-- DROP TABLE IF EXISTS chat_cabinet_waits;
-- COMMIT;
