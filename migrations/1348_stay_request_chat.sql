-- Migration 1348: переписка хозяина жилья и гостя по заявке (#2843)
-- Created: 2026-10-29
--
-- Слово владельца 29.10: «нужно чтоб с гостем он общался через этот же чат»,
-- «и срм была в чате макс у него привязан». На уточнения: гостю — «MAX +
-- страница заявки», телефон гостя хозяину — «Да, как сейчас».
--
-- До этого заявка хозяину (1206) уходила в MAX одним сообщением, и дальше
-- хозяин звонил сам: ответить в чате было нельзя, гость после заявки видел
-- только «передана», а CRM хозяина заявок не знала вовсе.
--
-- 1. stay_request_messages — сообщения по заявке. Автор — хозяин или гость.
--    Дверь — откуда пришло (чат MAX или страница заявки). Исход доставки
--    второй стороне в MAX записывается тремя значениями и причиной (§4.0):
--    'max' — дошло, 'no_address' — у получателя нет MAX (гость ещё не
--    подключил бота), 'failed' — MAX отказал. NULL — исход не записан.
--    Удалили заявку — сообщения уходят с ней (ON DELETE CASCADE).
--
-- 2. stay_requests.guest_max_chat_id — личный чат гостя с ботом. Пишется
--    «Стартом» по ссылке с ключом статуса заявки (1238). Перезаписать чужой
--    чат нельзя: условие в UPDATE, как у запроса мест (bindTouristChat).
--
-- 3. stay_chat_waits — «следующее сообщение этого чата — по заявке». Кнопка
--    «Ответить гостю» или «Написать владельцу» заводит ожидание на 30 минут,
--    следующее текстовое сообщение личного диалога уходит второй стороне, и
--    ожидание гаснет. Одно живое ожидание на чат: новая кнопка гасит прежнее.
--    Без ожидания сообщения в чате остаются кабинету или Кузьмичу, как
--    раньше: «запиши звонок» хозяина не уйдёт гостю.
--
-- 4. CRM: новый вид источника 'stay_request'. Заявка хозяину становится
--    клиентом: имя и телефон гостя хозяин уже получает в сообщении о заявке
--    (паритет tests/unit/crm-pd-parity.test.ts), согласие на передачу
--    владельцу записано в самой заявке (1206). Расширяются три проверки:
--    связь клиента, происхождение клиента, источник события ленты.
--
-- Идемпотентна.

BEGIN;

CREATE TABLE IF NOT EXISTS stay_request_messages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_request_id   UUID        NOT NULL REFERENCES stay_requests(id) ON DELETE CASCADE,
  author            TEXT        NOT NULL,
  door              TEXT        NOT NULL,
  body              TEXT        NOT NULL,
  delivery_channel  TEXT,
  delivery_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stay_request_messages_author_check CHECK (author IN ('owner', 'guest')),
  CONSTRAINT stay_request_messages_door_check CHECK (door IN ('max', 'page')),
  CONSTRAINT stay_request_messages_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT stay_request_messages_delivery_check
    CHECK (delivery_channel IS NULL OR delivery_channel IN ('max', 'no_address', 'failed')),
  CONSTRAINT stay_request_messages_reason_len CHECK (delivery_reason IS NULL OR char_length(delivery_reason) <= 300)
);

CREATE INDEX IF NOT EXISTS stay_request_messages_request_idx
  ON stay_request_messages (stay_request_id, created_at);

COMMENT ON TABLE stay_request_messages IS
  'Переписка хозяина жилья и гостя по заявке (1348, #2843). Текст — слова людей; в промпты моделей и в ответы инструментов MCP не уходит.';

ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS guest_max_chat_id BIGINT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS guest_chat_bound_at TIMESTAMPTZ;

COMMENT ON COLUMN stay_requests.guest_max_chat_id IS
  'Личный чат гостя с ботом MAX — по «Старту» со ссылкой ключа статуса заявки (1348). Чужой чат не перезаписывается.';

CREATE TABLE IF NOT EXISTS stay_chat_waits (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          TEXT        NOT NULL DEFAULT 'max',
  chat_id          BIGINT      NOT NULL,
  stay_request_id  UUID        NOT NULL REFERENCES stay_requests(id) ON DELETE CASCADE,
  side             TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'waiting',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  CONSTRAINT stay_chat_waits_channel_check CHECK (channel IN ('max')),
  CONSTRAINT stay_chat_waits_side_check CHECK (side IN ('owner', 'guest')),
  CONSTRAINT stay_chat_waits_status_check CHECK (status IN ('waiting', 'used', 'cancelled', 'superseded')),
  CONSTRAINT stay_chat_waits_used_check CHECK ((used_at IS NOT NULL) = (status = 'used'))
);

CREATE UNIQUE INDEX IF NOT EXISTS stay_chat_waits_one_per_chat
  ON stay_chat_waits (channel, chat_id) WHERE status = 'waiting';

-- CRM: заявка хозяину — источник клиента и события ленты.
ALTER TABLE crm_contact_links DROP CONSTRAINT IF EXISTS crm_contact_links_kind_check;
ALTER TABLE crm_contact_links ADD CONSTRAINT crm_contact_links_kind_check CHECK (source_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
  'lead', 'agent_client', 'stay_request'
));

ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_origin_check;
ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_origin_check CHECK (origin IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
  'lead', 'agent_client', 'stay_request', 'manual'
));

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_source_kind_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_source_kind_check CHECK (source_kind IS NULL OR source_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
  'lead', 'agent_client', 'seat_request', 'stay_request'
));

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM crm_events WHERE source_kind = 'stay_request';
-- DELETE FROM crm_contact_links WHERE source_kind = 'stay_request';
-- UPDATE crm_contacts SET origin = 'manual' WHERE origin = 'stay_request';
-- ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_source_kind_check;
-- ALTER TABLE crm_events ADD CONSTRAINT crm_events_source_kind_check CHECK (source_kind IS NULL OR source_kind IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
--   'lead', 'agent_client', 'seat_request'
-- ));
-- ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_origin_check;
-- ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_origin_check CHECK (origin IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
--   'lead', 'agent_client', 'manual'
-- ));
-- ALTER TABLE crm_contact_links DROP CONSTRAINT IF EXISTS crm_contact_links_kind_check;
-- ALTER TABLE crm_contact_links ADD CONSTRAINT crm_contact_links_kind_check CHECK (source_kind IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
--   'lead', 'agent_client'
-- ));
-- DROP TABLE IF EXISTS stay_chat_waits;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS guest_chat_bound_at;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS guest_max_chat_id;
-- DROP TABLE IF EXISTS stay_request_messages;
-- COMMIT;
