-- Migration 1195: CRM фаза 1, шаг 1а — клиент партнёра (#2325)
-- Created: 2026-10-09
--
-- Решение владельца 09.10: строим свою CRM (#2313), план фазы 1 — #2325
-- («план готов реализуем»).
--
-- Человека как сущности у партнёра не было. Брони туров, жилья, проката,
-- места в машине, лиды и клиенты агента держали его шестью разными
-- способами: у гостя `user_id` NULL, у проката имя и телефон лежат в заказе,
-- у перевозчика — только телефон, у агента — своя таблица. Одного туриста,
-- пришедшего дважды, партнёр видел двумя незнакомыми строками.
--
-- crm_contacts — клиент партнёра. Ключ склейки — телефон в E.164 внутри ОДНОГО
-- партнёра; нет телефона — почта; нет и её — аккаунт. Между партнёрами
-- контакты не склеиваются никогда: ПД туриста не перетекают от одного
-- партнёра к другому.
--
-- crm_contact_links — откуда контакт известен: источник (вид и id строки).
-- У источника один партнёр, поэтому один источник — один контакт.
--
-- CRM не расширяет доступ к ПД: в контакт попадают ровно те поля, которые
-- партнёр уже получает по этому источнику — на экранах и в уведомлении о
-- брони (lib/crm/contacts.ts). Поэтому источников шесть, а не восемь:
--   * гиду контакты из броней не копируются — его доступ к туристу временный
--     (назначение, команда оператора, предстоящая бронь — lib/guides/team-queries.ts);
--   * запрос мест не источник — контакты туриста оператор получает только
--     после ответа «есть места» (решение 29.09), и тогда клиента заводит бронь.
--
-- Согласие: копируется из источника, где оно записано (брони туров, лиды).
-- У жилья, проката, перевозчика и клиентов агента колонок согласия нет — у
-- контакта NULL, «не записано», а не выдуманное «да». Типы колонок согласия —
-- дословно как у 911/969/1108.
--
-- Виды источников и происхождения — только те, у которых в этом же PR есть
-- производитель (правило 10.09): хуки на создание шести источников и ручной
-- контакт. Происхождение 'mcp' придёт с шагом 1д своей миграцией.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  display_name        TEXT,
  phone               TEXT,
  phone_e164          TEXT,
  email               TEXT,
  email_norm          TEXT,
  origin              TEXT NOT NULL,
  tags                TEXT[] NOT NULL DEFAULT '{}',
  notes               TEXT,
  pd_consent_at       TIMESTAMPTZ,
  pd_consent_ip       VARCHAR(64),
  pd_consent_source   VARCHAR(64),
  pd_consent_version  VARCHAR(32),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_contacts_origin_check CHECK (origin IN (
    'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
    'lead', 'agent_client', 'manual'
  )),
  -- Имя может быть неизвестно (место в машине турист заказал одним телефоном):
  -- NULL — «не знаю», а не выдуманное «Без имени» (§4.0).
  CONSTRAINT crm_contacts_display_name_len CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT crm_contacts_notes_len CHECK (notes IS NULL OR char_length(notes) <= 5000),
  CONSTRAINT crm_contacts_tags_len CHECK (cardinality(tags) <= 20)
);

COMMENT ON TABLE crm_contacts IS 'Клиент партнёра (CRM фаза 1, #2325). Склейка — телефон E.164 внутри одного партнёра, затем почта, затем аккаунт.';
COMMENT ON COLUMN crm_contacts.phone_e164 IS 'Ключ склейки: lib/mcp/normalize-phone. NULL — телефона нет или он не читается как номер.';
COMMENT ON COLUMN crm_contacts.pd_consent_at IS 'Согласие на обработку ПД, скопированное из источника. NULL — не записано (не отказ).';

-- Ключи склейки. Почта и аккаунт — ключ только у контакта без телефона:
-- контакт с телефоном и той же почтой — тот же человек, его находит код
-- поиском по почте до вставки (lib/crm/contacts.ts).
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_partner_phone_uq
  ON crm_contacts (partner_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_partner_email_uq
  ON crm_contacts (partner_id, email_norm) WHERE phone_e164 IS NULL AND email_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_partner_user_uq
  ON crm_contacts (partner_id, user_id) WHERE phone_e164 IS NULL AND email_norm IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_contacts_partner_email_idx
  ON crm_contacts (partner_id, email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_contacts_partner_activity_idx
  ON crm_contacts (partner_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS crm_contact_links (
  id           BIGSERIAL PRIMARY KEY,
  contact_id   UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  partner_id   UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  source_kind  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_contact_links_kind_check CHECK (source_kind IN (
    'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
    'lead', 'agent_client'
  )),
  CONSTRAINT crm_contact_links_source_uq UNIQUE (source_kind, source_id)
);

COMMENT ON TABLE crm_contact_links IS 'Откуда контакт партнёру известен: источник (вид + id строки). Один источник — один контакт.';

CREATE INDEX IF NOT EXISTS crm_contact_links_contact_idx
  ON crm_contact_links (contact_id, occurred_at DESC);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS crm_contact_links;
-- DROP TABLE IF EXISTS crm_contacts;
-- COMMIT;
