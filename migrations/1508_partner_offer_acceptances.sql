-- 1508: журнал акцепта оферты партнёром (план готовности 23.11, этап 5).
--
-- Оферта для партнёров (/legal/offer, п. 2) называет акцептом в том числе
-- «проставление отметки о согласии с условиями настоящего договора». Отметки
-- на формах регистрации не было, и записать, кто и какую редакцию принял,
-- было некуда: партнёр заводился с одним согласием на обработку данных.
--
-- Здесь — только журнал. Текст оферты этой миграцией и этим этапом не
-- меняется, новых условий партнёрам не появляется.
--
-- Запись — производитель и потребитель в одном PR (§10.09):
--   · производители — двери регистрации партнёра (в одной транзакции с
--     созданием карточки) и кнопка «Принять оферту» в кабинете для тех, кто
--     заведён раньше;
--   · потребитель — пункт «Оферта» чек-листа готовности в кабинете партнёра.
--
-- Журнал только пополняется: повторный акцепт (новая редакция, второй раз
-- нажали) — новая строка, прежняя остаётся. UPDATE и DELETE по акцептам код
-- не делает; исключение — удаление аккаунта, которое стирает IP и ссылку на
-- человека, а сам факт акцепта карточкой оставляет.
--
-- Что хранится: карточка партнёра, кто нажал, версия оферты, время, IP и
-- откуда (регистрация или кабинет). User-agent не хранится: согласия на
-- обработку данных (911 и далее) его тоже не пишут, и лишнее ПД здесь ни к
-- чему.
--
-- Уже заведённых партнёров миграция не трогает: строк им не создаёт и на
-- витрине ничего не меняет. «Акцепта в журнале нет» — так и читается.
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS partner_offer_acceptances (
  id            BIGSERIAL PRIMARY KEY,
  partner_id    UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Кто нажал. NULL — аккаунт удалён: акцепт карточки остаётся.
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Редакция оферты, которую приняли (lib/legal/offer.ts, OFFER_VERSION).
  offer_version VARCHAR(32) NOT NULL,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL — стёрт вместе с аккаунтом.
  ip            VARCHAR(64),
  source        VARCHAR(16) NOT NULL,
  CONSTRAINT partner_offer_acceptances_version_set CHECK (btrim(offer_version) <> ''),
  CONSTRAINT partner_offer_acceptances_source_known CHECK (source IN ('registration', 'cabinet'))
);

CREATE INDEX IF NOT EXISTS idx_partner_offer_acceptances_partner
  ON partner_offer_acceptances (partner_id, accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_partner_offer_acceptances_user
  ON partner_offer_acceptances (user_id)
  WHERE user_id IS NOT NULL;
