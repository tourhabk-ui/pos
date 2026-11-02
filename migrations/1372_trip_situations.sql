-- 1372: обстановка на дату тура — одна строка на тур и день, и журнал
-- отправок (#2969, слово владельца 03.11 «карт-бланш»).
--
-- Номер 1372, а не 1371: в тот же час в main влилась 1371_conversation_reply_waits
-- (#2978). На проде этот файл под номером 1371 не применялся: выкат идёт только
-- после зелёного CI на main, а он краснел именно на столкновении номеров.
--
-- trip_situations: что Ведар знает об обстановке на день выезда тура
-- (погода по координатам тура, официальные предупреждения по зоне, оценка
-- опасности зоны). Пишет крон trip-reminders (lib/trips/situation-store),
-- читают «Сегодня» оператора в чате и напоминание за сутки. Три исхода:
-- calm / risk / unknown — «не смог проверить» не равно «спокойно» (§4.0).
--
-- trip_situation_notices: кому и что ушло, с исходом доставки. По нему же
-- повтор: туристу и оператору — только когда обстановка изменилась.

BEGIN;

CREATE TABLE IF NOT EXISTS trip_situations (
  tour_id     BIGINT NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  trip_date   DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('calm', 'risk', 'unknown')),
  line        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tour_id, trip_date)
);

CREATE TABLE IF NOT EXISTS trip_situation_notices (
  id             BIGSERIAL PRIMARY KEY,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('tourist_booking', 'tourist_lead', 'operator')),
  recipient_ref  TEXT NOT NULL,
  tour_id        BIGINT NOT NULL,
  trip_date      DATE NOT NULL,
  fingerprint    TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'no_channel', 'not_risk', 'unchanged')),
  channel        TEXT,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_situation_notices_recipient
  ON trip_situation_notices (recipient_kind, recipient_ref, trip_date, created_at DESC);

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS trip_situation_notices;
-- DROP TABLE IF EXISTS trip_situations;
