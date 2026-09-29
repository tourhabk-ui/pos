-- 1106: бронь на сайте самого объекта жилья (решение владельца 29.09).
--
-- Контекст. Подключение к TravelLine как канал продаж стоит 100 000 ₽ и
-- минимум 200 000 ₽ в год при нуле продаж; владелец отложил его до видимого
-- спроса. Бесплатный путь, который работает сразу: у многих объектов края
-- есть СВОЙ модуль брони с живыми ценами и наличием (у «Голубой лагуны» —
-- bluelagoon.su/booking на TravelLine). Карточка на Ведаре ведёт туда
-- кнопкой «Забронировать на сайте отеля». Нам — ни копейки комиссии, туристу
-- — правда о ценах вместо выдуманного «от … ₽».
--
-- external_booking_url — только https: ссылка открывается туристу, и
-- http-адрес или «javascript:» здесь недопустимы по построению.
--
-- «Голубая лагуна» — первой. Записано только проверяемое, у каждого факта
-- источник (миграция 1035): имя, сайт и берег озера Микижа — слово
-- владельца 26.09; адрес брони — разбор сайта того же вечера; координаты —
-- карточка озера Микижа. Цены НЕТ (NULL): её никто не называл, и на
-- карточке стоит «цена на сайте отеля», а не число по памяти (§4.0).
-- Зона планера (planner_zone) НЕ ставится: по решению 26.09 (миграция 1031)
-- зону не угадывают — её ставит администратор. До этого объект есть в
-- каталоге и у Кузьмича, но планер его не предлагает.
-- Опубликован сразу (approved) — решение владельца 29.09 «ставим на её
-- карточку»; is_verified остаётся false: договора с объектом нет.
--
-- Идемпотентна: колонка IF NOT EXISTS, объект — по имени, повтор ничего не
-- плодит и не перетирает правки администратора.

ALTER TABLE accommodations
  ADD COLUMN IF NOT EXISTS external_booking_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_external_booking_https'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_external_booking_https
      CHECK (external_booking_url IS NULL OR external_booking_url ~ '^https://[^\s]+$');
  END IF;
END $$;

INSERT INTO accommodations
  (name, type, description, short_description, address, coordinates, location_zone,
   is_active, is_verified, moderation_status, moderated_at, external_booking_url)
SELECT
  'Голубая лагуна',
  'resort',
  'СПА-отель на берегу озера Микижа в долине Паратунки. У отеля причал с лодками и водными велосипедами и бассейн. Номера, цены и свободные даты — на сайте отеля: бронь идёт через его собственную систему.',
  'СПА-отель на озере Микижа, Паратунка',
  'Озеро Микижа, Паратунка',
  jsonb_build_object('lat', 53.01045, 'lng', 158.26904),
  'Паратунка',
  true, false, 'approved', NOW(),
  'https://bluelagoon.su/booking'
WHERE NOT EXISTS (
  SELECT 1 FROM accommodations WHERE LOWER(name) IN ('голубая лагуна', 'лагуна')
);
