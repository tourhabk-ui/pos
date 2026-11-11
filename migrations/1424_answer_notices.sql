-- 1424: исход сообщения человеку после ответа туроператора кнопкой.
-- Created: 2026-11-11
--
-- План «после отказа» (слово владельца 11.11, «карт-бланш по плану
-- действуй»), этап 2б-1. До этой миграции «Нет мест», «Отказать» и «Другая
-- дата» туристу не сообщались никак: ответ видел только тот, кто сам открыл
-- статус. Правило владельца того же дня: «мы доверяем агенту» — ответ
-- доставлен, когда его принял чат человека, ИИ-агент прочитал статус или
-- принял вебхук; не доставлен — менеджер узнаёт сразу, без таймеров.
--
-- Одна строка — один ответ кнопкой (partner_incoming_answers, 1334/1422):
-- рождается в той же команде, что и сам ответ, и только у ответа, который эта
-- команда вставила, — повтор нажатия второго сообщения не даёт.
--
-- ПД здесь нет: ни id чатов, ни телефона, ни текста — только исход и коды.
--
-- Переходы — условными UPDATE по `state`; доставка «хотя бы раз», не «ровно
-- один»: если процесс упадёт между отправкой и записью исхода, добивка
-- (/api/cron/answer-notices) после захвата в 5 минут отправит ещё раз.

BEGIN;

CREATE TABLE IF NOT EXISTS answer_notices (
  id                 BIGSERIAL   PRIMARY KEY,
  lead_id            UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  answer_id          BIGINT      NOT NULL REFERENCES partner_incoming_answers(id) ON DELETE CASCADE,
  answer             TEXT        NOT NULL,
  decline_reason     TEXT        NULL,
  lead_status_before TEXT        NULL,
  state              TEXT        NOT NULL DEFAULT 'pending',
  skipped_reason     TEXT        NULL,
  delivered_via      TEXT        NULL,
  tried              TEXT        NULL,
  attempts           INT         NOT NULL DEFAULT 0,
  claimed_until      TIMESTAMPTZ NULL,
  manager_channel    TEXT        NULL,
  manager_alerted_at TIMESTAMPTZ NULL,
  manager_cleared_at TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ NULL,
  CONSTRAINT answer_notices_answer_uidx UNIQUE (answer_id),
  CONSTRAINT answer_notices_answer_check CHECK (answer IN ('no_seats', 'decline', 'other_date')),
  CONSTRAINT answer_notices_reason_check
    CHECK (decline_reason IS NULL OR decline_reason IN ('seats', 'weather', 'dates', 'group', 'other')),
  CONSTRAINT answer_notices_state_check CHECK (state IN ('pending', 'delivered', 'undelivered', 'skipped')),
  CONSTRAINT answer_notices_skip_check
    CHECK ((state = 'skipped') = (skipped_reason IS NOT NULL)
           AND (skipped_reason IS NULL OR skipped_reason IN ('lead_closed', 'not_addressee', 'self', 'outgrown'))),
  CONSTRAINT answer_notices_via_check
    CHECK ((state = 'delivered') = (delivered_via IS NOT NULL)
           AND (delivered_via IS NULL OR delivered_via IN ('max', 'telegram', 'agent_webhook', 'agent_read', 'page_seen'))),
  -- Куда пробовали — только имена каналов и коды, по форме 1348: без id чатов и текста ошибок.
  CONSTRAINT answer_notices_tried_check CHECK (tried IS NULL OR tried ~ '^[a-z0-9_:,]{1,400}$'),
  CONSTRAINT answer_notices_manager_check CHECK (manager_channel IS NULL OR manager_channel IN ('max', 'telegram-stub', 'none'))
);

CREATE INDEX IF NOT EXISTS answer_notices_lead_idx ON answer_notices (lead_id);
-- Добивка и сторож: обрыв, недоставленное без менеджера, «звонить не нужно».
CREATE INDEX IF NOT EXISTS answer_notices_open_idx ON answer_notices (created_at)
  WHERE state IN ('pending', 'undelivered')
     OR (state = 'delivered' AND manager_alerted_at IS NOT NULL AND manager_cleared_at IS NULL);

-- Обратный путь «заявка → чаты человека»: уникальный индекс 1416 начинается
-- с канала, а по key_id идёт и каскадное удаление.
CREATE INDEX IF NOT EXISTS chat_request_links_key_idx ON chat_request_links (key_id);

COMMENT ON TABLE answer_notices IS
  'Исход сообщения человеку после ответа туроператора кнопкой (план «после отказа», 2б). Без ПД.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS chat_request_links_key_idx;
-- DROP TABLE IF EXISTS answer_notices;
-- COMMIT;
