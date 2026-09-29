-- 1104: запрос свободных мест у оператора (решение владельца 29.09).
--
-- Зачем. Планер знает свободные места только по расписанию, которое оператор
-- завёл сам (tour_availability). Большинство операторов его не ведёт, и тур
-- без расписания в режиме «с оператором» из плана выпадал с пометкой «нет
-- мест» — два разных факта («даты не заведены» и «всё продано») туристу
-- выглядели одинаково. Отсюда запрос: турист спрашивает дату и число людей,
-- оператор отвечает одним нажатием в своём мессенджере.
--
-- Решения владельца 29.09, записанные схемой:
--   - «Есть места» СРАЗУ создаёт бронь и подтверждает её (booking_id);
--   - на ответ — 2 часа (deadline_at); после — 'expired', «оператор не
--     ответил», и это НЕ «мест нет» (§4.0);
--   - ответ туристу — в его мессенджер (reply_channel).
--
-- Исходы (status):
--   pending     — ждёт ответа оператора;
--   confirmed   — места есть, бронь заведена и подтверждена (booking_id);
--   declined    — мест нет;
--   other_date  — на эту дату нет, оператор предложил alt_date;
--   expired     — оператор не ответил за срок;
--   failed      — оператор сказал «есть», но бронь завести не удалось
--                 (failure_reason: учёт платформы видит дату закрытой или
--                 занятой) — это разногласие, а не отказ, и его разбирает
--                 человек.
--
-- ПД туриста (имя, телефон) хранятся здесь, пока запрос не станет бронью;
-- согласие — обстоятельствами (pd_consent_*), как в operator_bookings.
-- Оператору имя и телефон уходят только через MAX (lib/notifications/pd-alert).
--
-- Идемпотентна.

CREATE TABLE IF NOT EXISTS tour_seat_requests (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id             BIGINT       NOT NULL REFERENCES operator_tours(id),
  operator_id         UUID         NOT NULL REFERENCES partners(id),
  tour_date           DATE         NOT NULL,
  participants        INTEGER      NOT NULL CHECK (participants BETWEEN 1 AND 100),
  tourist_name        VARCHAR(255) NOT NULL,
  tourist_phone       VARCHAR(20)  NOT NULL,
  -- Где турист хочет получить ответ. 'phone' — звонок/страница статуса.
  reply_channel       VARCHAR(16)  NOT NULL
                      CHECK (reply_channel IN ('telegram', 'max', 'whatsapp', 'phone')),
  -- Чат туриста в Telegram/MAX — появляется, когда он нажал «Старт» по ссылке
  -- со страницы статуса. NULL — «ещё не подключился», а не «некуда».
  tourist_chat_id     BIGINT,
  -- Хэш ключа страницы статуса (сам ключ отдаётся туристу один раз).
  status_token_hash   CHAR(64)     NOT NULL UNIQUE,
  status              VARCHAR(16)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'confirmed', 'declined', 'other_date', 'expired', 'failed')),
  alt_date            DATE,
  booking_id          BIGINT       REFERENCES operator_bookings(id),
  -- Ключ доступа к брони (миграция 943 хранит у брони только хэш, а сам ключ
  -- отдаётся один раз — здесь его получает запрос, а не человек). Лежит
  -- ЗАШИФРОВАННЫМ (lib/encryption, AES-256-GCM): страница статуса отдаёт его
  -- туристу по его же ключу статуса. NULL — брони нет или ключ шифрования не
  -- задан (тогда ссылка уходит туристу только сообщением).
  booking_access_token_enc TEXT,
  failure_reason      TEXT,
  -- Как ушло оператору: 'max' | 'telegram-stub' | 'none' (lib/notifications/pd-alert).
  operator_delivery   VARCHAR(16),
  deadline_at         TIMESTAMPTZ  NOT NULL,
  answered_at         TIMESTAMPTZ,
  -- Откуда пришёл ответ: 'max' | 'telegram' | 'web'.
  answered_via        VARCHAR(16),
  -- Когда туристу ушёл исход (в мессенджер). NULL — не уходил.
  tourist_notified_at TIMESTAMPTZ,
  source              VARCHAR(32)  NOT NULL DEFAULT 'planner',
  pd_consent_at       TIMESTAMPTZ  NOT NULL,
  pd_consent_ip       VARCHAR(64),
  pd_consent_source   VARCHAR(32),
  pd_consent_version  VARCHAR(32),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_request_confirmed_has_booking
    CHECK (status <> 'confirmed' OR booking_id IS NOT NULL),
  CONSTRAINT seat_request_other_date_has_date
    CHECK (status <> 'other_date' OR alt_date IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_pending
  ON tour_seat_requests (deadline_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_operator
  ON tour_seat_requests (operator_id, created_at DESC);
