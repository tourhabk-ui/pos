-- Migration 1466: акция оператора на карточке тура — со сроком и источником
-- Created: 2026-11-17
--
-- Наблюдение за сайтами партнёров 17.11 нашло у «Лагуны Экспедиции» новую
-- акцию «Для жителей Дальнего Востока» (страница акций laguna-expedition.ru,
-- сверено 17.11). На вопрос «Показывать эту акцию на наших карточках?»
-- владелец ответил «покажи» (17.11).
--
-- Акция — слово оператора о своём туре, а не цена Ведара: право на неё
-- (прописка) Ведар не проверяет, поэтому цену в заявке не меняет. Строка
-- хранит, что даёт акция по этому туру, кому и когда, срок бронирования,
-- адрес, откуда условия взяты, и день сверки. Карточка тура и ответ ИИ-агенту
-- (get_tour_details, чат Кузьмича) показывают строку, пока сегодня по Камчатке
-- лежит в сроке бронирования; после booking_until она пропадает сама.
-- Порядок туров на витринах акция не меняет (правило 1в, §0).
--
-- Правило чтения и слова — lib/tours/tour-promotion.ts.
-- Идемпотентно: таблица IF NOT EXISTS, строки — ON CONFLICT DO NOTHING.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_promotions (
  id            BIGSERIAL PRIMARY KEY,
  tour_id       INTEGER NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  offer         TEXT NOT NULL CHECK (length(btrim(offer)) > 0),
  conditions    TEXT NOT NULL CHECK (length(btrim(conditions)) > 0),
  booking_from  DATE NOT NULL,
  booking_until DATE NOT NULL,
  source_url    TEXT NOT NULL CHECK (source_url ~ '^https://'),
  checked_on    DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tour_promotions_period_check CHECK (booking_from <= booking_until),
  CONSTRAINT tour_promotions_one_per_source UNIQUE (tour_id, source_url, booking_from)
);

CREATE INDEX IF NOT EXISTS tour_promotions_tour_until_idx
  ON tour_promotions (tour_id, booking_until);

COMMENT ON TABLE tour_promotions IS
  'Акция оператора по туру: что даёт, кому, срок бронирования, источник и день сверки. Показ — пока сегодня по Камчатке в сроке (lib/tours/tour-promotion.ts). Цену не меняет.';

CREATE TEMP TABLE _promo1466 (slug text, offer text) ON COMMIT DROP;
INSERT INTO _promo1466 (slug, offer) VALUES
  ('lagexp-kamchatka-termalnyj-marshrut',
   'Скидка 15 000 ₽ с человека при бронировании на основных местах. Продление проживания по тарифу «Всё включено» (с алкогольными напитками на обед и ужин) — 10 000 ₽ за номер до двух человек, в категориях «Голубое озеро», гостевые дома «Стандарт», «Лесной (Форест)» и «Глазастик».'),
  ('lagexp-vulkany-kamchatki-4-dnya', 'Ужин по тарифу «Всё включено» в подарок.'),
  ('lagexp-vulkany-kamchatki-5-dnej', 'Ужин по тарифу «Всё включено» в подарок.'),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut', 'Ужин по тарифу «Всё включено» в подарок.');

DO $$
DECLARE
  v_tours int;
  v_added int;
BEGIN
  SELECT COUNT(DISTINCT t.id) INTO v_tours
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _promo1466 l ON l.slug = t.slug
   WHERE t.deleted_at IS NULL;
  IF v_tours <> 4 THEN
    RAISE WARNING '[1466] туров «Лагуны Экспедиции» найдено %, ожидалось 4', v_tours;
  END IF;

  INSERT INTO tour_promotions
    (tour_id, title, offer, conditions, booking_from, booking_until, source_url, checked_on)
  SELECT t.id,
         'Для жителей Дальнего Востока',
         l.offer,
         'Для жителей Дальнего Востока с действующей пропиской. Поездки с 18 ноября по 29 декабря 2026 года и с 11 января по 31 мая 2027 года. Не суммируется с другими акциями и специальными предложениями оператора. Мест по акции ограниченное число.',
         DATE '2026-11-18', DATE '2026-12-01',
         'https://laguna-expedition.ru/aktsii/dlya-zhitelej-dalnego-vostoka',
         DATE '2026-11-17'
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _promo1466 l ON l.slug = t.slug
   WHERE t.deleted_at IS NULL
  ON CONFLICT ON CONSTRAINT tour_promotions_one_per_source DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RAISE NOTICE '[1466] туров: %, записано акций: %', v_tours, v_added;
END $$;

COMMIT;
