-- 1348: уведомление агенту об изменении заявки (слово владельца 29.10:
-- «делай, я не знал про эту дыру»).
--
-- Внешний агент (MCP, A2A, OpenAPI) создаёт заявку пишущим инструментом и
-- получает ключ статуса (1220). Состояние он видел, только если спрашивал
-- сам: перенос и отмену брони, отказ, другую дату он узнавал, когда
-- приходило в голову опросить get_request_status. Здесь — подписка на
-- изменения: агент оставляет notify_url при создании заявки, а сверка
-- (/api/cron/agent-request-notify, шаг cron-safety-heartbeat) шлёт на него
-- подписанный POST (Standard Webhooks), когда состояние, дата, предложенная
-- дата, тур или число человек изменились.
--
-- Связь — с КЛЮЧОМ, не с заявкой: один вызов пишущего инструмента = один
-- ключ = не больше одной подписки (key_id UNIQUE). Удалили заявку — ушёл
-- ключ (1220, ON DELETE CASCADE) — ушла подписка.
--
-- Адрес и ключ подписи лежат только зашифрованными (AES-256-GCM,
-- lib/encryption encryptBound, AAD — ref строки): в пути и query приёмника
-- бывают его собственные токены, а ключ подписи в открытом виде позволил бы
-- любой копии базы подделывать наши уведомления. Хешировать ключ подписи
-- нельзя — HMAC требует сам ключ. В открытом виде — только хост (url_host):
-- для логов и бюджета отправок на хост. После отключения адрес и ключ
-- стираются, а строка удаляется сверкой через 30 дней (152-ФЗ, ст. 5 ч. 7:
-- хост приёмника бывает личным доменом человека).
--
-- last_* — последний ДОСТАВЛЕННЫЙ снимок (или база отсчёта при создании):
-- с ним сверка сравнивает текущий вид заявки (buildRequestView). Снимок —
-- только поля состояния и каталога: название тура берётся из operator_tours,
-- никогда не из текста человека. Имени, телефона, комментария, номера лида и
-- брони здесь нет и быть не может: колонок для них нет, jsonb нет вовсе.
--
-- Кто читает служебные колонки: last_error, failing_since и
-- last_delivered_at — сверка молчания нашей сети (ответ крона, прогон
-- partial, тревога сторожа «крон идёт, результата нет»); они же и
-- last_body_sha256 — разбор одной подписки по номеру
-- (GET /api/cron/agent-request-notify?ref=nr_…): почему отключена, когда
-- доставлено последнее, хэш тела, чтобы сверить с тем, что получил агент.
--
-- disabled_reason (внутренний словарь; наружу агенту — тремя словами, см.
-- lib/mcp/request-notify-schema):
--   gone          — приёмник ответил 410;
--   rejected      — приёмник ответил 4xx, который повтор не исправит
--                   (кроме 408, 425, 429): адрес не приёмник;
--   undeliverable — исчерпан график повторов (7 неудач, ~31 ч);
--   expired       — истёк срок (равен сроку ключа, 90 дней);
--   undecryptable — адрес или ключ подписи не расшифровались при заданном
--                   ENCRYPTION_KEY (сбой нашей стороны).
--
-- Идемпотентна: IF NOT EXISTS у таблицы и индексов. Без BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS agent_request_notify (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id             UUID         NOT NULL UNIQUE REFERENCES agent_request_keys(id) ON DELETE CASCADE,
  ref                VARCHAR(40)  NOT NULL UNIQUE,
  url_enc            TEXT         NULL,
  url_host           VARCHAR(253) NOT NULL,
  secret_enc         TEXT         NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  -- последний доставленный снимок (или база отсчёта при создании)
  baseline_at        TIMESTAMPTZ  NULL,
  last_state         VARCHAR(32)  NULL,
  last_date          DATE         NULL,
  last_alt_date      DATE         NULL,
  last_tour          VARCHAR(300) NULL,
  last_participants  INTEGER      NULL,
  last_fingerprint   CHAR(64)     NULL,
  last_body_sha256   CHAR(64)     NULL,
  last_delivered_at  TIMESTAMPTZ  NULL,
  delivered_count    INTEGER      NOT NULL DEFAULT 0,
  -- текущая недоставленная разница
  attempts           SMALLINT     NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ  NULL,
  last_attempt_at    TIMESTAMPTZ  NULL,
  -- начало текущей серии неудач (NULL — серии нет): по нему сверка судит,
  -- не молчит ли наша сеть — с начала отказов не доставлено ни одно
  failing_since      TIMESTAMPTZ  NULL,
  last_error         VARCHAR(40)  NULL,
  claimed_until      TIMESTAMPTZ  NULL,
  disabled_at        TIMESTAMPTZ  NULL,
  disabled_reason    VARCHAR(24)  NULL,
  CONSTRAINT agent_request_notify_disabled_pair
    CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL)),
  CONSTRAINT agent_request_notify_reason
    CHECK (disabled_reason IS NULL OR disabled_reason IN ('gone', 'rejected', 'undeliverable', 'expired', 'undecryptable')),
  CONSTRAINT agent_request_notify_live_has_target
    CHECK (disabled_at IS NOT NULL OR (url_enc IS NOT NULL AND secret_enc IS NOT NULL)),
  CONSTRAINT agent_request_notify_attempts CHECK (attempts >= 0 AND delivered_count >= 0),
  CONSTRAINT agent_request_notify_error_code CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT agent_request_notify_ref_form CHECK (ref ~ '^nr_[A-Za-z0-9_-]{16,36}$')
);

-- Живые подписки — отбор сверки каждые 30 минут.
CREATE INDEX IF NOT EXISTS agent_request_notify_live_idx
  ON agent_request_notify (expires_at) WHERE disabled_at IS NULL;

-- Уборка отключённых через 30 дней.
CREATE INDEX IF NOT EXISTS agent_request_notify_disabled_idx
  ON agent_request_notify (disabled_at) WHERE disabled_at IS NOT NULL;

COMMENT ON TABLE agent_request_notify IS
  'Подписка внешнего агента на изменения заявки (1348): адрес и ключ подписи зашифрованы, хост открыт; last_* — последний доставленный снимок без ПД. Производитель — /api/cron/agent-request-notify.';

-- Rollback:
-- DROP TABLE IF EXISTS agent_request_notify;
