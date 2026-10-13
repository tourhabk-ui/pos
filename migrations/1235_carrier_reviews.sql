-- Migration 1235: отзывы о перевозчике — только от тех, кто ехал (слово владельца 13.10)
-- Created: 2026-10-13
--
-- Владелец 13.10: «делай блок отзывов но логично».
--
-- ── Что значит «логично» ───────────────────────────────────────────────────
--
-- Отзыв оставляет только тот, кто ехал, и каждый отзыв помнит, чем это
-- доказано (proof). Доказательств два, и они разной природы:
--
--   · 'seat' — место в поездке перевозчика, заказанное через Ведар
--     (transfer_seat_bookings): перевозчик его подтвердил, поездка не
--     отменена, её дата прошла по Камчатке. Это факт платформы, отдельного
--     подтверждения не нужно — как у тура, который завершается сам на
--     следующий день (решение владельца 13.10).
--
--   · 'charter' — машина под заказ (заявка = лид с operator_id перевозчика).
--     Заявка — НЕ поездка: машина ею не закрепляется, и состоялась ли
--     поездка, система не знает. Право даёт подтверждение менеджера Ведара
--     «поездка состоялась» — он посредник по заявке («подтверждает менеджер
--     с перевозчиком») — и одноразовая ссылка, которую он отправляет
--     заказчику. Подтверждение и ссылка живут в carrier_review_invites:
--     в базе только хэш ключа, сам ключ показывается один раз.
--
-- Анонимного пути нет: без подтверждённого места и без ссылки писать некуда.
--
-- Рейтинг перевозчика здесь НЕ хранится: он считается при чтении из видимых
-- отзывов. Денормализованное число, которое кто-то обязан пересчитывать,
-- врёт (087 записала «31 отзыв» при трёх; триггер рейтинга партнёров снят
-- в 1101).
--
-- Скрыть отзыв — решение модератора с причиной (как 878 у туров: «пустая
-- причина — не решение, а мнение»); держит CHECK, а не только форма.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS carrier_review_invites (
  -- Одна заявка — одно подтверждение поездки. Новая ссылка по той же заявке
  -- заменяет хэш: прежняя ссылка перестаёт работать.
  lead_id            UUID PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  partner_id         UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  key_hash           TEXT NOT NULL UNIQUE,
  -- Кто и когда подтвердил, что поездка состоялась.
  ride_confirmed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ride_confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS carrier_reviews (
  id               BIGSERIAL PRIMARY KEY,
  partner_id       UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  proof            VARCHAR(10) NOT NULL CHECK (proof IN ('seat', 'charter')),
  -- Один отзыв на заказанное место и один на заявку — держит UNIQUE, а не
  -- проверка в коде (check-then-act проигрывает гонку двух вкладок).
  seat_booking_id  UUID UNIQUE REFERENCES transfer_seat_bookings(id) ON DELETE SET NULL,
  lead_id          UUID UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Подпись как её дал автор: имя аккаунта (место в поездке) или то, что он
  -- написал сам (ссылка по заявке). Публично — «Имя Ф.» (publicReviewerName).
  author_name      VARCHAR(80) NOT NULL CHECK (length(btrim(author_name)) > 0),
  rating           SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          TEXT NOT NULL DEFAULT '',
  -- Что за поездка — снимок на момент отзыва: заявку и поездку могут
  -- поправить или удалить, а отзыв должен по-прежнему говорить, о чём он.
  ride_date        DATE,
  ride_from        TEXT,
  ride_to          TEXT,
  is_hidden        BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason    TEXT,
  hidden_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carrier_reviews_single_basis CHECK (seat_booking_id IS NULL OR lead_id IS NULL),
  CONSTRAINT carrier_reviews_hidden_reason CHECK (
    NOT is_hidden OR length(btrim(COALESCE(hidden_reason, ''))) >= 8
  )
);

CREATE INDEX IF NOT EXISTS idx_carrier_reviews_partner_visible
  ON carrier_reviews (partner_id, created_at DESC) WHERE NOT is_hidden;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS carrier_reviews;
-- DROP TABLE IF EXISTS carrier_review_invites;
-- COMMIT;
