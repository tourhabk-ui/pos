-- Migration 1363: неотправленная заявка — для одного напоминания (возврат брошенной заявки)
-- Created: 2026-11-01
--
-- Слово владельца 01.11: одно напоминание о неотправленной заявке, ТОЛЬКО при
-- отдельном согласии на повторный контакт (lib/legal/recontact-consent.ts),
-- через MAX или Telegram, в окне 1–72 ч от начала заявки. Кнопка «Отправить
-- заявку» ведёт на /request-resume#<resume_token>; отправляет сам человек.
--
-- ПД здесь минимум: только текст пожелания (comment), без имени и телефона.
-- Адрес мессенджера не копируется — читается из users при отправке.
CREATE TABLE IF NOT EXISTS request_drafts (
  id                           BIGSERIAL PRIMARY KEY,
  resume_token                 TEXT NOT NULL UNIQUE,
  user_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel                      TEXT CHECK (channel IN ('max', 'telegram')),
  title                        TEXT,
  comment                      TEXT,
  recontact_consent_version    TEXT,
  recontact_consent_at         TIMESTAMPTZ,
  recontact_withdrawn_at       TIMESTAMPTZ,
  reminders_sent               INT NOT NULL DEFAULT 0 CHECK (reminders_sent <= 1),
  reminded_at                  TIMESTAMPTZ,
  submitted_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_request_drafts_due
  ON request_drafts (created_at)
  WHERE submitted_at IS NULL AND reminders_sent = 0 AND recontact_withdrawn_at IS NULL;
