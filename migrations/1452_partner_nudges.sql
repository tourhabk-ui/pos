-- Migration 1452: напоминание партнёру от Watchdog — раз в сутки
-- Created: 2026-11-16
--
-- #3433 п. 6, слово владельца 16.11 «Раз в сутки»: напоминания Watchdog
-- партнёру («у тебя N броней ждут ответа» — оператору, владельцу жилья,
-- прокату, перевозчику) уходили при КАЖДОМ прогоне сторожа: каждые 30 минут
-- из start.js и раз в час с GitHub — до ~72 одинаковых сообщений в сутки
-- одному человеку, в том числе ночью, пока бронь не закрыта. Ни дедупа, ни
-- тихих часов, ни следа отправки.
--
-- partner_nudges — замок «сегодня уже напоминали» и журнал отправки: одна
-- строка на партнёра, вид напоминания и камчатские сутки (UNIQUE). Строка
-- `sending` ставится ДО отправки (два прогона сторожа не пошлют дважды) и
-- снимается при недоставке (следующий прогон попробует снова); итог — канал
-- доставки, max или telegram. Ни имён, ни телефонов, ни чисел броней здесь
-- нет. Строки старше 30 суток удаляет сам писатель (lib/partners/daily-nudge).
--
-- Идемпотентно: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_nudges (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL,
  day         DATE        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'sending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  CONSTRAINT partner_nudges_kind_check CHECK (kind IN ('operator_booking', 'stay_booking', 'gear_rental', 'transfer_seat')),
  CONSTRAINT partner_nudges_status_check CHECK (status IN ('sending', 'max', 'telegram')),
  CONSTRAINT partner_nudges_sent_check CHECK ((sent_at IS NOT NULL) = (status <> 'sending'))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_nudges_once_a_day
  ON partner_nudges (partner_id, kind, day);

CREATE INDEX IF NOT EXISTS partner_nudges_day
  ON partner_nudges (day);

COMMIT;
