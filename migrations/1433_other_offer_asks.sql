-- Migration 1433: вопрос другим компаниям после отказа (план «после отказа», этап 4б)
-- Created: 2026-11-12
--
-- После отказа туроператора человеку называют другие компании с турами к тому
-- же месту на его дату (этап 4а) — по календарю. Календарь — не слово компании:
-- у тура без расписания «может принять» вообще неизвестно. Теперь Ведар
-- спрашивает сами компании: «возьмёте на эту дату?» — БЕЗ имени и телефона
-- человека (слова владельца 11.11: «передавать другим — да»; согласие человек
-- давал одному оператору, поэтому другим уходит вопрос, а не заявка).
--
-- Строка — один вопрос одной компании по одной заявке на одну дату:
--   lead_id, ask_date, people — о ком вопрос (без ПД: тур, дата, число людей);
--   partner_id, tour_id       — кому и про какой его тур;
--   sent_via                  — куда вопрос дошёл; NULL — не дошёл (send_note — почему);
--   answer                    — «take» (Беру) / «decline» (Не могу); один на вопрос;
--   told_via                  — каким чатом человек узнал о «Беру»; NULL — чата нет
--                               или не принял: ответ он увидит в статусе заявки.
--
-- Сама заявка никому не передаётся: «Беру» ставит компанию в список человека
-- с пометкой, заявку ей он оставляет сам. Имени и телефона в таблице нет.
--
-- Идемпотентна: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS other_offer_asks (
  id           BIGSERIAL   PRIMARY KEY,
  lead_id      UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  partner_id   UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  tour_id      BIGINT      NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  ask_date     DATE        NOT NULL,
  people       INT         NOT NULL,
  asked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_via     TEXT        NULL,
  send_note    TEXT        NULL,
  answer       TEXT        NULL,
  answered_at  TIMESTAMPTZ NULL,
  answered_via TEXT        NULL,
  told_via     TEXT        NULL,
  told_at      TIMESTAMPTZ NULL,
  CONSTRAINT ooa_one_per_company UNIQUE (lead_id, partner_id, ask_date),
  CONSTRAINT ooa_people_check CHECK (people BETWEEN 1 AND 999),
  CONSTRAINT ooa_sent_via_check CHECK (sent_via IS NULL OR sent_via IN ('max', 'telegram')),
  CONSTRAINT ooa_send_note_len CHECK (send_note IS NULL OR char_length(send_note) <= 200),
  CONSTRAINT ooa_answer_check CHECK (answer IS NULL OR answer IN ('take', 'decline')),
  CONSTRAINT ooa_answered_pair CHECK ((answer IS NULL) = (answered_at IS NULL)),
  CONSTRAINT ooa_answered_via_check CHECK (answered_via IS NULL OR answered_via IN ('max', 'telegram')),
  CONSTRAINT ooa_told_via_check CHECK (told_via IS NULL OR told_via IN ('max', 'telegram')),
  CONSTRAINT ooa_told_pair CHECK ((told_via IS NULL) = (told_at IS NULL)),
  -- Человеку сообщают только о «Беру».
  CONSTRAINT ooa_told_only_take CHECK (told_via IS NULL OR answer = 'take')
);

CREATE INDEX IF NOT EXISTS ooa_lead_date_idx ON other_offer_asks (lead_id, ask_date);

COMMENT ON TABLE other_offer_asks IS
  'Вопрос другой компании после отказа туроператора: «возьмёте на эту дату?» — без имени и телефона человека (lib/requests/offer-asks).';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS other_offer_asks;
-- COMMIT;
