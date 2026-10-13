-- 1229: задачи и память разговора A2A переживают перезапуск сервиса.
--
-- 12.10 задачи A2A решено было держать только в памяти процесса: «час в
-- памяти это покрывает», а таблица хранила бы переписку агентов с именами и
-- телефонами. 13.10 журнал A2A показал, что часа нет: agent-collector спросил
-- GetTask через 11 минут после своего SendMessage и получил TaskNotFound —
-- каждый пуш в main перезапускает контейнер, а 13.10 с 18:30 до 21:10 по
-- Камчатке их было больше двадцати. Ответ «задачи хранятся час» был неправдой;
-- с той же памятью пропадала и переписка по contextId — второй вопрос агента
-- терял первый. Решение — по праву, данному владельцем 13.10 («я на это даю
-- тебе право решить самому»).
--
-- Граница с ПД (152-ФЗ) та же, что у журнала общения (1225), и строже:
--   · срок — час, как и обещано агентам; старое удаляет сам писатель
--     (lib/a2a/durable-store) перед каждой записью, отдельного крона нет;
--   · в базу кладётся копия, а не ответ как есть: тексты проходят redactPII
--     (телефоны и почты — плейсхолдеры), ссылка «продолжить» с токеном
--     handoff не хранится вовсе, а у пишущих инструментов (заявки) вместо
--     ответа — заглушка без ключа статуса: агент получил его в ответе
--     SendMessage, а ключ в открытом виде в базе — второй ключ от заявки;
--   · память разговора — по 32-знаковому hash contextId (тот же ключ, что
--     a2a_requests.context_key и a2a_dialogs.context_key), реплики после
--     redactPII, не больше десяти;
--   · входящее сообщение агента в задачу по-прежнему не кладётся.
--
-- Память процесса остаётся первым слоем: пока сервис не перезапускался,
-- агент получает задачу ровно такой, какой она ушла в ответ; копия из базы
-- нужна только после перезапуска.
--
-- И отдельно — журнал запросов: имя метода, которого у нас нет. 13.10
-- BrickBlueBot получил MethodNotFound, а что он прислал, журнал не знал.

CREATE TABLE IF NOT EXISTS a2a_tasks (
  -- id задачи, выданный SendMessage (randomUUID); GetTask принимает до 128 знаков
  task_id     VARCHAR(128) PRIMARY KEY,
  -- TaskRecord после redactPII; у пишущих инструментов — заглушка без ключа
  record      JSONB        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_expires_at
  ON a2a_tasks (expires_at);

COMMENT ON TABLE a2a_tasks IS
  'Задачи A2A на час, чтобы GetTask переживал перезапуск: копия после redactPII, без ссылки handoff, у заявок — без ключа статуса';

CREATE TABLE IF NOT EXISTS a2a_contexts (
  -- sha256 от contextId, 32 знака — тот же ключ, что a2a_requests.context_key
  context_key VARCHAR(32)  PRIMARY KEY,
  -- до десяти последних реплик [{role, content}] после redactPII
  turns       JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_a2a_contexts_expires_at
  ON a2a_contexts (expires_at);

COMMENT ON TABLE a2a_contexts IS
  'Память разговора A2A по hash contextId на час: до десяти реплик после redactPII';

ALTER TABLE a2a_requests ADD COLUMN IF NOT EXISTS method VARCHAR(64);

COMMENT ON COLUMN a2a_requests.method IS
  'Что прислал агент, когда метода или пути у нас нет (MethodNotFound): имя метода JSON-RPC или «ГЛАГОЛ /путь» REST, только безопасные знаки';
