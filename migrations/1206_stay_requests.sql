-- 1206: заявка на жильё «через владельца» — форма на карточке, доставка в MAX
-- хозяина (решение владельца 10.10: «для броней нужна удобная форма для
-- приложения MAX»).
--
-- У «Кутхи» (1179) нет ни номеров, ни аккаунта владельца, ни сайта брони —
-- только телефон. Наша форма брони (accommodation_bookings) для неё не
-- годится: она требует номер, вход гостя, а заявку подтверждает владелец из
-- кабинета, которого нет. Поэтому заявка здесь — не бронь, а запрос хозяину:
-- даты, сколько гостей, имя и телефон. Хозяин получает её одним сообщением в
-- MAX и перезванивает сам; цену и даты подтверждает он.
--
-- 1. Партнёр «Кутха». Писать в MAX бот может только тому, кто нажал «Старт»
--    (по номеру телефона адреса в MAX нет — tests/unit/max-contact). Адрес
--    живёт в partners.max_chat_id и пишется ботом по подписанной ссылке
--    (lib/partners/channel-link, кнопка «ссылка на бота» в списке партнёров
--    администратора). Значит объекту нужен партнёр. Категория stay, без slug
--    и is_public = false: в публичный каталог операторов он не попадает.
--    Рейтинг NULL — «не оценён» (1027). Связь только объекту без партнёра.
--
-- 2. stay_requests — седьмая копия согласия на ПД (реестр в
--    tests/unit/pd-consent-registry.test.ts), типы как у 911. Согласие
--    записывается В ТОЙ ЖЕ вставке, что заявка, и без него строки нет
--    (NOT NULL): телефон туриста уходит хозяину жилья, и запись — то, чем
--    платформа докажет, что человек на это согласился и под каким текстом.
--
-- Идемпотентна.

INSERT INTO partners (name, category, contact, is_public, is_verified, rating)
SELECT 'Кутха', 'stay', jsonb_build_object('phone', a.contact_phone), FALSE, FALSE, NULL
  FROM accommodations a
 WHERE LOWER(a.name) = 'кутха'
   AND a.partner_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM partners p WHERE p.category = 'stay' AND LOWER(p.name) = 'кутха'
   );

UPDATE accommodations a
   SET partner_id = p.id,
       updated_at = NOW()
  FROM partners p
 WHERE LOWER(a.name) = 'кутха'
   AND a.partner_id IS NULL
   AND p.category = 'stay'
   AND LOWER(p.name) = 'кутха';

CREATE TABLE IF NOT EXISTS stay_requests (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  accommodation_id   UUID        NOT NULL REFERENCES accommodations(id) ON DELETE CASCADE,
  check_in_date      DATE        NOT NULL,
  check_out_date     DATE        NOT NULL,
  guests             INTEGER     NOT NULL,
  guest_name         TEXT        NOT NULL,
  guest_phone        TEXT        NOT NULL,
  comment            TEXT,
  pd_consent_at      TIMESTAMPTZ NOT NULL,
  pd_consent_ip      VARCHAR(64) NOT NULL,
  pd_consent_source  VARCHAR(64) NOT NULL,
  pd_consent_version VARCHAR(32) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stay_requests_dates  CHECK (check_out_date > check_in_date),
  CONSTRAINT stay_requests_guests CHECK (guests BETWEEN 1 AND 50)
);

CREATE INDEX IF NOT EXISTS idx_stay_requests_accommodation
  ON stay_requests (accommodation_id, created_at DESC);

COMMENT ON TABLE stay_requests IS 'Заявка хозяину жилья без своей брони (форма карточки, 1206): даты, гости, контакты и согласие на ПД. Не бронь — даты и цену подтверждает хозяин.';
COMMENT ON COLUMN stay_requests.pd_consent_version IS 'Версия текста согласия (lib/legal/pd-consent, вариант для жилья).';
