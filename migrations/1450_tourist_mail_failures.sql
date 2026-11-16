-- 1450: письмо туристу о брони не ушло — факт в базе, а не только в памяти.
--
-- Задача #3433 п. 4; слово владельца 16.11 «Тревога надёжно». Письмо брони
-- (ссылка гостю, подтверждение оператора) при отказе почты повторялось через
-- 5 минут таймером в памяти процесса, и тревога владельцу «турист не получил
-- ссылку» тоже жила там. Выкат или падение в эти 5 минут — ни повтора, ни
-- тревоги (lib/notifications/tourist-mail).
--
-- Строка — факт «письмо по брони не ушло с первой попытки»: номер брони,
-- область (кто слал) и время. ПД нет: ни адреса, ни темы, ни текста письма.
-- Повтор остаётся в памяти; ушло со второй попытки — `resolution = 'sent'`,
-- не ушло и тревога владельцу дошла — `'alerted'`. Строку, которую не закрыл
-- никто за 15 минут (процесс перезапустился), называет Watchdog
-- (checkUndeliveredTouristMail) — тревогой, а не повтором.
--
-- Идемпотентна: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS tourist_mail_failures (
  id          BIGSERIAL   PRIMARY KEY,
  booking_id  TEXT        NOT NULL CHECK (char_length(booking_id) BETWEEN 1 AND 64),
  scope       TEXT        NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 64),
  failed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  resolution  TEXT        NULL CHECK (resolution IN ('sent', 'alerted')),
  CONSTRAINT tourist_mail_failures_resolved_pair CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

CREATE INDEX IF NOT EXISTS tourist_mail_failures_open_idx
  ON tourist_mail_failures (failed_at)
  WHERE resolved_at IS NULL;
