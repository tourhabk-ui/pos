-- 1105: запрос свободных мест у оператора (решение владельца 29.09).
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
--   failed      — запрос не довели до конца; причина в failure_kind:
--                   delivery   — оператору не удалось доставить сообщение;
--                   accounting — оператор сказал «есть», а учёт платформы видит
--                                дату закрытой или занятой (разногласие, не
--                                отказ);
--                   system     — сбой при заведении или подтверждении брони;
--                   unfinished — ответ принят, а процесс оборвался до записи
--                                исхода (подобрано уборщиком).
--                 Читатель у 'failed' есть: проверка Watchdog
--                 (lib/agents/watchdog.ts, checkFailedSeatRequests) — без неё
--                 «мы разбираемся» было бы обещанием без исполнителя (§10.09).
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
  -- Нормализованный (lib/mcp/normalize-phone): по нему ищутся дубли запроса.
  tourist_phone       VARCHAR(20)  NOT NULL,
  -- Где турист хочет получить ответ. 'phone' — звонок/страница статуса.
  reply_channel       VARCHAR(16)  NOT NULL
                      CHECK (reply_channel IN ('telegram', 'max', 'whatsapp', 'phone')),
  -- Чат туриста в Telegram/MAX — появляется, когда он нажал «Старт» по ссылке
  -- со страницы статуса. NULL — «ещё не подключился», а не «некуда».
  tourist_chat_id     BIGINT,
  -- Хэш ключа страницы статуса (сам ключ отдаётся туристу один раз).
  status_token_hash   CHAR(64)     NOT NULL UNIQUE,
  -- Сам ключ страницы статуса, ЗАШИФРОВАННЫЙ (lib/encryption): сообщение
  -- туристу, которое уходит позже (уборщик просрочки), должно нести ссылку на
  -- его страницу, а по хэшу её не собрать. NULL — ключ шифрования не задан.
  status_token_enc    TEXT,
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
  failure_kind        VARCHAR(16)
                      CHECK (failure_kind IS NULL OR failure_kind IN ('delivery', 'accounting', 'system', 'unfinished')),
  -- Как ушло оператору: 'max' | 'telegram-stub' | 'none' (lib/notifications/pd-alert).
  operator_delivery   VARCHAR(16),
  deadline_at         TIMESTAMPTZ  NOT NULL,
  answered_at         TIMESTAMPTZ,
  -- Откуда пришёл ответ: 'max' | 'telegram' | 'web'.
  answered_via        VARCHAR(16),
  -- Когда туристу ушёл исход (в мессенджер). NULL — не уходил.
  tourist_notified_at TIMESTAMPTZ,
  -- Сколько раз пытались сообщить исход туристу в мессенджер (уборщик
  -- повторяет, пока не дойдёт или пока не кончится потолок попыток).
  tourist_notify_attempts INTEGER  NOT NULL DEFAULT 0,
  -- Код агентской ссылки (KH-AGT-…), с которым турист пришёл: переезжает в
  -- бронь, чтобы продажа не теряла атрибуцию (обзор 29.09).
  referral_code       VARCHAR(32),
  source              VARCHAR(32)  NOT NULL DEFAULT 'planner',
  pd_consent_at       TIMESTAMPTZ  NOT NULL,
  pd_consent_ip       VARCHAR(64),
  pd_consent_source   VARCHAR(32),
  pd_consent_version  VARCHAR(32),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_request_confirmed_has_booking
    CHECK (status <> 'confirmed' OR booking_id IS NOT NULL),
  CONSTRAINT seat_request_failed_has_kind
    CHECK (status <> 'failed' OR failure_kind IS NOT NULL),
  CONSTRAINT seat_request_other_date_has_date
    CHECK (status <> 'other_date' OR alt_date IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_pending
  ON tour_seat_requests (deadline_at) WHERE status = 'pending';

-- Один ожидающий запрос на (тур, дата, телефон): двойное нажатие «Отправить» и
-- скрипт с одним номером не плодят строки и сообщения оператору. Гонку двух
-- одновременных вставок закрывает сама база (23505), а не проверка в коде.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tour_seat_requests_pending_same
  ON tour_seat_requests (tour_id, tour_date, tourist_phone) WHERE status = 'pending';

-- Уборщик: принятые, но не доведённые ответы и неотправленные исходы.
CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_unfinished
  ON tour_seat_requests (answered_at) WHERE status = 'pending' AND answered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_unnotified
  ON tour_seat_requests (updated_at)
  WHERE status <> 'pending' AND tourist_notified_at IS NULL AND tourist_chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tour_seat_requests_operator
  ON tour_seat_requests (operator_id, created_at DESC);
