-- Migration 1415: журнал писем с данными выезда для МЧС
-- Created: 2026-11-10
--
-- Слово владельца 10.11: «api мчс нет или нам не дают форма сложная можем
-- попробывать пока письмом на flo@vedarai.ru потом после тестов свяжусь с
-- МЧС». Оператор и гид из кабинета в чате отправляют данные выезда письмом
-- (lib/safety/mchs-letter). Пока это ТЕСТ: получатель — ящик Ведара, не МЧС.
--
-- mchs_letters — что отправлялось: чья карточка, какой тур и дата выезда,
-- откуда нажали, куда ушло, тест ли это и чем кончилось. Без журнала повтор
-- нажатия слал бы второе письмо, а «отправляли ли» не знал бы никто.
--
-- Персональных данных в журнале нет: ни имён, ни телефонов туристов, ни
-- текста письма — только счёт людей и броней. Причина отказа пишется
-- очищенной (lib/security/pii-redact).
--
-- `outcome`: sent — почтовый сервер принял письмо; failed — не принял;
-- not_configured — почта на сервере не настроена. «sent» не значит
-- «зарегистрировано в МЧС» и не значит «в МЧС ушло»: куда — говорит sent_to
-- и is_test.
--
-- Идемпотентно: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS mchs_letters (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  operator_tour_id  BIGINT      NOT NULL,
  departure_date    DATE        NOT NULL,
  channel           TEXT        NOT NULL,
  sent_to           TEXT        NOT NULL,
  is_test           BOOLEAN     NOT NULL,
  outcome           TEXT        NOT NULL,
  error             TEXT,
  people            INTEGER     NOT NULL,
  bookings          INTEGER     NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mchs_letters_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT mchs_letters_outcome_check CHECK (outcome IN ('sent', 'failed', 'not_configured')),
  CONSTRAINT mchs_letters_counts_check CHECK (people >= 0 AND bookings > 0)
);

CREATE INDEX IF NOT EXISTS mchs_letters_departure_idx
  ON mchs_letters (partner_id, operator_tour_id, departure_date, created_at DESC);

COMMENT ON TABLE mchs_letters IS
  'Журнал писем с данными выезда для МЧС (1415): карточка, тур, дата выезда, канал нажатия, получатель, тест ли, исход. Без имён, телефонов и текста письма.';
COMMENT ON COLUMN mchs_letters.is_test IS
  'TRUE — письмо ушло на тестовый ящик Ведара, не в МЧС.';
COMMENT ON COLUMN mchs_letters.outcome IS
  'sent — почтовый сервер принял; failed — не принял; not_configured — почта не настроена. Не статус регистрации в МЧС.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS mchs_letters;
-- COMMIT;
