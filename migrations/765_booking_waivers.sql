-- Migration 765: цифровой вейвер (согласие с рисками + медицинская декларация)
-- для высокорисковых туров (вулканы, вертолёт, рафтинг, зимние выходы).
--
-- Зачем: перед опасным туром турист осознанно подтверждает риски и декларирует
-- здоровье/аллергии/экстренный контакт. Это свойство безопасности платформы
-- (§7 vedar): гид и МЧС при ЧП должны знать про хронические болезни/аллергии.
-- Одна бронь — один вейвер (UNIQUE), переподписание обновляет запись.
--
-- Идемпотентно (IF NOT EXISTS). operator_bookings.id — BIGINT, users.id — UUID.

CREATE TABLE IF NOT EXISTS booking_waivers (
  id                       BIGSERIAL PRIMARY KEY,
  booking_id               BIGINT NOT NULL UNIQUE
                             REFERENCES operator_bookings(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL
                             REFERENCES users(id) ON DELETE CASCADE,

  -- Электронная подпись: ФИО подписавшего (совпадает с туристом брони)
  signer_name              VARCHAR(255) NOT NULL,

  -- Осознание рисков (обязательная галочка) + пригодность к участию (самодекларация)
  risks_acknowledged       BOOLEAN NOT NULL DEFAULT false,
  fit_to_participate        BOOLEAN NOT NULL DEFAULT false,

  -- Медицинская декларация (необязательные поля, минимизация данных)
  medical_conditions       TEXT,
  allergies                TEXT,

  -- Экстренный контакт (обязателен — кому звонить при ЧП)
  emergency_contact_name   VARCHAR(255) NOT NULL,
  emergency_contact_phone  VARCHAR(50)  NOT NULL,

  signed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_waivers_user
  ON booking_waivers(user_id);
