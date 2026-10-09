-- Migration 1196: CRM фаза 1, шаг 1б — лента событий клиента (#2325)
-- Created: 2026-10-09
--
-- Решение владельца 09.10 («Хорошо реализуем»): у клиента партнёра появляется
-- одна лента на все роли — что с ним происходило и кто это сделал.
--
-- До этого журналов было три, и ни один не был лентой клиента:
-- `booking_logs` пишет только booking.service (PATCH кабинета оператора
-- меняет статус мимо него), `lead_activity_log` знает только лиды,
-- `client_communications` висит на устаревшей `bookings`. У жилья, проката
-- и перевозчика журнала нет вовсе.
--
-- Событие привязано к партнёру и к клиенту; источник (вид и id строки)
-- хранится рядом, чтобы лента открывалась и с карточки брони. Контакт может
-- исчезнуть (удаление клиента) — событие остаётся у партнёра с contact_id
-- NULL: лента — журнал, а журнал не переписывается.
--
-- Виды событий — только те, у которых в этом же PR есть производитель
-- (правило 10.09): смена статуса источника, изменение брони без смены
-- статуса (перенос даты, назначение или снятие гида), заметка/звонок/встреча
-- руками партнёра, сообщение чата в обе стороны. `task_done` придёт с
-- задачами (шаг 1в) своей миграцией.
--
-- ПД в ленте: заголовок и payload строит код из статусов и названий; текст
-- заметки пишет партнёр о своём клиенте и хранит в своей базе (РФ). В
-- модель заметки уходят только через redactPII (шаг 1д).

BEGIN;

CREATE TABLE IF NOT EXISTS crm_events (
  id             BIGSERIAL PRIMARY KEY,
  partner_id     UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  source_kind    TEXT,
  source_id      TEXT,
  kind           TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_events_kind_check CHECK (kind IN (
    'status_change', 'change', 'note', 'call', 'meeting', 'message_in', 'message_out'
  )),
  CONSTRAINT crm_events_actor_check CHECK (actor_kind IN (
    'partner_user', 'tourist', 'system', 'kuzmich', 'mcp', 'admin'
  )),
  -- Источник либо назван целиком, либо не назван вовсе (заметка партнёра).
  CONSTRAINT crm_events_source_pair CHECK ((source_kind IS NULL) = (source_id IS NULL)),
  CONSTRAINT crm_events_source_kind_check CHECK (source_kind IS NULL OR source_kind IN (
    'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
    'lead', 'agent_client'
  )),
  CONSTRAINT crm_events_title_len CHECK (char_length(title) BETWEEN 1 AND 300)
);

COMMENT ON TABLE crm_events IS 'Лента клиента партнёра (CRM фаза 1, #2325): смены статуса источников, касания партнёра, сообщения чата. Журнал — не переписывается.';
COMMENT ON COLUMN crm_events.contact_id IS 'NULL — клиент удалён после записи события; событие остаётся у партнёра.';
COMMENT ON COLUMN crm_events.payload IS 'Детали без ПД: from/to статуса, дата поездки, текст заметки партнёра (details).';

CREATE INDEX IF NOT EXISTS crm_events_partner_idx
  ON crm_events (partner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS crm_events_contact_idx
  ON crm_events (contact_id, occurred_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_events_source_idx
  ON crm_events (source_kind, source_id) WHERE source_kind IS NOT NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS crm_events;
-- COMMIT;
