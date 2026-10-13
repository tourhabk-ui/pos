-- 1225: журнал общения A2A — что агенты спрашивают у Кузьмича и что он отвечает.
--
-- Решение владельца 13.10: «заведем журнал общения для A2A». Повод — две строки
-- журнала запросов (1219) от незнакомых агентов, TaifoonHarvester и
-- brick.blue-proxy: «текст · выполнено · 6–8 с». Кто пришёл и чем кончилось,
-- было видно; что спросили и что им ответили — нет: журнал запросов текст не
-- хранит по построению.
--
-- Граница с журналом запросов намеренная. a2a_requests остаётся без текста
-- (её сторож — a2a-journal-admin); текст живёт ЗДЕСЬ, в отдельной таблице, у
-- которой свой срок и своя чистка:
--   · вопрос и ответ проходят redactPII (lib/security/pii-redact) до записи —
--     телефоны и почты заменяются плейсхолдерами. Имя человека по тексту не
--     отличить от обычных слов, поэтому оно может остаться — отсюда срок;
--   · хранится 90 суток (столько же, сколько самое длинное окно страницы
--     /hub/admin/a2a). Старое удаляет сам писатель (lib/a2a/dialog-log) —
--     тем же приёмом, что mcp_write_attempts и kuzmich_safety_reviews:
--     отдельного крона, который мог бы молча не запуститься, нет;
--   · сырые User-Agent, IP и contextId не хранятся: агент — самоназвание
--     программы (как в 1219), диалог — тот же 32-знаковый hash contextId, что
--     a2a_requests.context_key, поэтому реплики одного разговора и его строки
--     в журнале запросов соединяются.
--
-- Пишутся только вопросы, дошедшие до Кузьмича. Отказ по лимиту адреса (10 в
-- минуту) сюда не попадает: он виден в журнале запросов как rejected, а
-- запись его текста дала бы спамеру способ писать в базу без предела.
--
-- Пишет lib/a2a/dialog-log.ts, читает /api/admin/analytics/a2a (блок dialogs)
-- → /hub/admin/a2a, карточка «Журнал общения».

CREATE TABLE IF NOT EXISTS a2a_dialogs (
  id           BIGSERIAL    PRIMARY KEY,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- самоназвание программы (lib/a2a/journal agentLabel), не заголовок целиком
  agent        VARCHAR(64)  NOT NULL,
  -- род по заголовку — та же таксономия, что a2a_requests.ua_family
  ua_family    VARCHAR(24)  NOT NULL,
  -- суточный hash вызывающего (lib/mcp/call-log mcpCallerHash)
  caller_hash  VARCHAR(64)  NOT NULL,
  -- sha256 от contextId, 32 знака — тот же ключ, что a2a_requests.context_key
  context_key  VARCHAR(32),
  -- номер реплики агента в разговоре, с единицы
  turn         INTEGER      NOT NULL DEFAULT 1,
  -- вопрос агента после redactPII, до 2000 знаков
  question     TEXT         NOT NULL,
  -- ответ Кузьмича (или текст отказа) после redactPII, до 6000 знаков
  answer       TEXT         NOT NULL,
  -- completed — ответил; failed — модель не ответила; rejected — отказ
  state        VARCHAR(16)  NOT NULL,
  duration_ms  INTEGER,
  -- свой клиент (метка владельца в адресе), как is_self у a2a_requests
  is_self      BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_a2a_dialogs_created_at
  ON a2a_dialogs (created_at DESC);

COMMENT ON TABLE a2a_dialogs IS
  'Журнал общения A2A: вопрос агента и ответ Кузьмича после redactPII (телефоны и почты вычищены), 90 суток; User-Agent, IP и contextId в открытом виде не хранятся';
