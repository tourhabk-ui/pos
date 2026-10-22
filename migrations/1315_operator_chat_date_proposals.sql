-- 1315: предложение «открыть даты» из чата кабинета оператора в MAX
-- (решение владельца 22.10, вариант а; спецификация «Открой даты словами»,
-- этап C, §6).
--
-- Номер 1315: числовой max + 1 по main на день сведения. Ветка заводила
-- файл под 1313, пока 1311 и 1312 держал открытый PR #2688 (сайты
-- партнёров); 1313 влил раньше #2693 (CRM при удалении аккаунта), 1314 —
-- WhatsApp в tg_conversations, и номер сдвинут дважды — сторож
-- migration-order не пускает два файла под одним номером.
--
-- Оператор пишет в чат кабинета «открой субботы июля, 8 мест». Кузьмич
-- разбирает фразу правилами и показывает точный список: тур, даты с годом,
-- места и что сейчас с каждой датой. До нажатия «Открыть» tour_availability
-- не меняется. Между сообщением и нажатием предложение живёт здесь, а кнопка
-- несёт только id строки: право нажатия даёт чат кабинета, а не знание uuid
-- (lib/operators/chat-dates/flow).
--
-- Статусы и их производители (все в этом же PR, правило 10.09):
--   draft      — нет тура (выбор кнопками) или мест (вопрос);
--   ready      — тур и места есть, предложение показано;
--   done       — «Открыть» нажато, запись прошла, исход по датам в outcome;
--   refused    — «Открыть» нажато, а тур снят, скрыт или больше не этого
--                оператора: ничего не записано, причина в outcome;
--   superseded — в том же чате пришла новая фраза: новое предложение или
--                поправка, на которую поток ответил отказом или вопросом;
--   cancelled  — нажато «Не надо» или написано «отмена», «стоп», «не надо».
-- «Истекло» — не статус, а вычисление expires_at <= NOW().
--
-- Чего в строке нет намеренно: текста фразы и user_id из MAX. Строка — журнал
-- действия: кто (partner_id, chat_id), что, когда (used_at), итог (outcome).
--
-- Повторы MAX не пишут второй раз: фраза — по source_mid, ответ числом мест —
-- по seats_source_mid (номер сообщения, заполнившего места черновика).
--
-- Идемпотентна: IF NOT EXISTS у таблицы, колонки и индексов.

CREATE TABLE IF NOT EXISTS operator_chat_date_proposals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel            VARCHAR(16) NOT NULL DEFAULT 'max' CHECK (channel IN ('max')),
  chat_id            BIGINT NOT NULL,
  -- Номер исходного сообщения MAX (body.mid): повтор апдейта не заводит
  -- второе предложение и не шлёт его второй раз.
  source_mid         TEXT,
  tour_id            BIGINT REFERENCES operator_tours(id) ON DELETE CASCADE,
  -- Туры на выбор, когда фраза не назвала один: кнопка несёт индекс, не id.
  candidate_tour_ids BIGINT[],
  dates              DATE[] NOT NULL CHECK (cardinality(dates) BETWEEN 1 AND 31),
  seats              INTEGER CHECK (seats BETWEEN 1 AND 500),
  -- Номер сообщения MAX, ответившего числом мест на вопрос черновика: повтор
  -- того же апдейта не уходит помощнику кабинета и не шлёт предложение дважды.
  seats_source_mid   TEXT,
  -- Пометки к превью: во фразе была цена (из чата не меняется) и
  -- «выходные»/«будни» (праздничные дни не учитываются).
  price_mentioned    BOOLEAN NOT NULL DEFAULT FALSE,
  weekday_words      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Правило фразы словами («будни июля 2027»): превью после черновика (тур
  -- кнопкой, места числом) показывает его так же, как сразу. Слова разбора,
  -- а не фраза оператора; NULL — фраза перечисляла даты.
  rule_words         TEXT,
  -- Время сообщения по часам MAX (timestamp апдейта): повтор старого
  -- сообщения, пришедший после нового предложения, его не снимает и не
  -- заменяет (шестой ревью). NULL — время не пришло: снимается, как раньше.
  source_sent_at     TIMESTAMPTZ,
  status             VARCHAR(16) NOT NULL
                     CHECK (status IN ('draft', 'ready', 'done', 'refused', 'superseded', 'cancelled')),
  outcome            JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  CONSTRAINT ocdp_ready_complete CHECK (status <> 'ready' OR (tour_id IS NOT NULL AND seats IS NOT NULL)),
  CONSTRAINT ocdp_used_final     CHECK ((used_at IS NOT NULL) = (status IN ('done', 'refused'))),
  CONSTRAINT ocdp_outcome_final  CHECK ((outcome IS NOT NULL) = (status IN ('done', 'refused')))
);

-- Таблица, заведённая до колонки (ветка с прежним номером 1311), получает её здесь.
ALTER TABLE operator_chat_date_proposals ADD COLUMN IF NOT EXISTS seats_source_mid TEXT;
ALTER TABLE operator_chat_date_proposals ADD COLUMN IF NOT EXISTS rule_words TEXT;
ALTER TABLE operator_chat_date_proposals ADD COLUMN IF NOT EXISTS source_sent_at TIMESTAMPTZ;

-- Одно действующее предложение на чат: новая фраза заменяет прежнее.
CREATE UNIQUE INDEX IF NOT EXISTS ocdp_one_active_per_chat
  ON operator_chat_date_proposals (channel, chat_id) WHERE status IN ('draft', 'ready');
-- Повтор того же сообщения (две копии одного апдейта) — одна строка.
CREATE UNIQUE INDEX IF NOT EXISTS ocdp_source_mid
  ON operator_chat_date_proposals (channel, chat_id, source_mid) WHERE source_mid IS NOT NULL;
-- Одно сообщение заполняет места одного черновика: повтор находится по номеру.
CREATE UNIQUE INDEX IF NOT EXISTS ocdp_seats_source_mid
  ON operator_chat_date_proposals (channel, chat_id, seats_source_mid) WHERE seats_source_mid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ocdp_partner_created
  ON operator_chat_date_proposals (partner_id, created_at DESC);
