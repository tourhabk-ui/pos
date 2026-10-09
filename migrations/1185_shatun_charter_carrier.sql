-- 1185: перевозчик «Шатун» — вахтовки КамАЗ под заказ, прайс 2026 года (#2240).
--
-- Владелец 09.10 прислал данные перевозчика и 20 снимков: «При расчёте
-- наличными цена на 2026 год из города Петропавловск-Камчатский. Вахтовка на
-- базе КамАЗ, 26 посадочных. Авачинский 65 т.р., Горелый 75 т.р., Вачкажец
-- 70 т.р., озеро Курильское 450 т.р. + переправы, Толбачик (мёртвый лес)
-- 360 т.р. + 30 т.р. в день при эксплуатации транспорта на местности.
-- Шатун, трансфер, 2 вахтовки, телефон, WhatsApp и Telegram». Выбрано владельцем:
-- карточка перевозчика с ценами «под заказ» (поездок с датами и местами у
-- него нет, витрина /transfers пуста — #2240) и «это фото Шатуна, он
-- согласен».
--
-- ── Почему отдельная таблица, а не transfer_trips ─────────────────────────
--
-- Поездка (926) — это машина, дата и места: «в среду едем на Горелый, свободно
-- 6 мест по 3500». У «Шатуна» другое: целая машина по прайсу, даты назначает
-- заказчик. Положить прайс в поездки значило бы выдумать дату и места, а в
-- `partners.services` (JSONB) — завести второй экземпляр факта рядом с
-- таблицей. Поэтому цены лежат в одном месте — `transfer_charter_prices`, и
-- оба читателя (экран /transfers и карточка /operators/shatun, а также
-- Кузьмич и MCP search_transfers) берут их через `lib/transfers/charter.ts`.
--
-- ── Что записано дословно, чего НЕТ ────────────────────────────────────────
--
--   • Цена — за МАШИНУ, не за место: 65 000 ₽ за одно место было бы
--     абсурдом, а делить на 26 — значит придумать цифру. Поэтому «за место»
--     нигде не считается.
--   • «Плюс переправы» у Курильского озера — текстом (price_note). Сколько они
--     стоят, в прайсе не сказано, и числа не появляется.
--   • «+30 000 ₽ в день при эксплуатации транспорта на местности» — отдельная
--     строка (line_kind = 'extra_day'), а не прибавка к каждой цене: к какому
--     направлению она применима, кроме слов «при эксплуатации на местности»,
--     владелец не уточнял.
--   • «При расчёте наличными» — условие прайса (conditions); цены при другой
--     форме расчёта в прайсе не названы. Платформа оплату не принимает
--     (05.10): договариваются и платят перевозчику напрямую.
--   • Сколько дней длится поездка за базовую цену, туда-обратно или в один
--     конец, что входит (топливо, водитель) — в прайсе нет, и колонок под это
--     нет: пустое лучше придуманного (§4.0).
--   • Юрлицо, ИНН, адрес — не названы; company_name и legal_info пусты,
--     is_verified = FALSE: перевозчика платформа не проверяла.
--   • Место базирования не названо: «из Петропавловска-Камчатского» относится
--     к ПРАЙСУ (откуда считается поездка), а не к адресу перевозчика.
--   • Комиссия: ставку не назначали, колонка остаётся с умолчанием схемы
--     (811); платежей через платформу у перевозчика нет.
--   • Рейтинг 0, как у прочих категорий: экран читает «0» как «не оценён» и
--     рисует тире. NULL тут хуже — ORDER BY rating DESC ставит NULL ПЕРВЫМ, и
--     перевозчик без единой оценки возглавил бы каталог операторов.
--
-- ── Номер ─────────────────────────────────────────────────────────────────
--
-- +7 929 456-01-02 — номер перевозчика с его слов: звонок, WhatsApp и Telegram.
-- MAX не назван, и ссылки на него нет. Номер показывается на карточке и на
-- экране /transfers; в ответ AI-инструментов (Кузьмич, MCP) он не уходит —
-- только ссылка на карточку (152-ФЗ: модели зарубежные).
--
-- ── Фото ──────────────────────────────────────────────────────────────────
--
-- 23 снимка (public/images/shatun/shatun-01..23.jpg): 20 прислал владелец с
-- данными перевозчика, ещё три — по его же слову «из этих тоже что-то выбрать,
-- они атмосферные» (из пяти закатных кадров взяты три: вечерний берег с
-- надписью на борту, закат с открытой дверью, вечер с огнями; кадр, где машина
-- едва видна вдали, и второй вечерний «в лоб», почти повторяющий взятый,
-- не взяты). Порядок: герой — вечерний берег с надписью «Шатун», затем машины,
-- салон, природа. Права — у перевозчика, перенос по его согласию, переданному
-- владельцем; подпись «Фото: Шатун». Сжаты sharp до 1600 px/q80 без
-- метаданных, варианты — npm run images. Первый снимок — герой карточки, в
-- галерее остальные 22: герой не повторяется рядом с самим собой.
--
-- ── Видео ─────────────────────────────────────────────────────────────────
--
-- Владелец прислал ролик на 80 секунд: вахтовка с синей кабиной идёт вброд через
-- реку, рядом стоит паром. Положен на карточку как есть, без подписи о том,
-- ГДЕ снято и в какое направление: этого в присланном нет (§4.0). Сжат в
-- 640x360, 24 к/с, ~3,4 МБ (оригинал 16,9 МБ, 848x478 при 60 к/с), метаданные
-- сняты; рядом кадр-обложка. Права и согласие — как у фото.
--
-- Колонки partners.video_url и video_poster_url заведены ради него: у партнёра
-- не было места под видео (галерея — только картинки, и путь к ролику в ней
-- сломал бы каждого, кто читает её как набор снимков). Обе пусты у всех
-- остальных; ролик без обложки не принимается базой — плеер без кадра на
-- мобильной сети чёрный прямоугольник. Читатель один — lib/transfers/charter.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS video_url        TEXT,
  ADD COLUMN IF NOT EXISTS video_poster_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partners_video_shape'
  ) THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_video_shape
      CHECK (
        video_url IS NULL
        OR (video_url ~ '^/video/[a-z0-9/._-]+\.(mp4|webm)$'
            AND video_poster_url IS NOT NULL
            AND video_poster_url ~ '^/video/[a-z0-9/._-]+\.(jpg|webp)$')
      );
  END IF;
END $$;

-- ── Парк ──────────────────────────────────────────────────────────────────
--
-- Две машины (на снимках одна с синей кабиной, другая с оранжевой), по 26 мест.
-- Заведены в transfer_fleet_vehicles — когда у перевозчика появится кабинет,
-- поездки с датами заводятся уже на них. `user_id` пуст: аккаунта нет.
--
-- Идемпотентна: таблица и колонки IF NOT EXISTS, партнёр — по slug, машины и цены — по
-- ключу; повтор ничего не плодит и не перетирает правки администратора.

BEGIN;

CREATE TABLE IF NOT EXISTS transfer_charter_prices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id    UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  vehicle_kind  VARCHAR(20) NOT NULL CHECK (vehicle_kind IN ('jeep', 'vahtovka', 'minibus', 'other')),
  -- 'destination' — цена за машину на направление; 'extra_day' — доплата за
  -- каждый день работы машины на месте (направления у неё нет).
  line_kind     VARCHAR(12) NOT NULL CHECK (line_kind IN ('destination', 'extra_day')),
  from_text     VARCHAR(255),
  to_text       VARCHAR(255),
  -- Целые рубли: прайс называет «65 т.р.», копеек в нём нет. NULL быть не может —
  -- строка без цены не прайс; «цену не назвали» выражается отсутствием строки.
  price_rub     INTEGER NOT NULL CHECK (price_rub > 0),
  price_note    VARCHAR(255),
  conditions    TEXT,
  -- Год прайса. NULL — «не записан», а не «бессрочный».
  valid_year    INTEGER CHECK (valid_year IS NULL OR valid_year BETWEEN 2020 AND 2100),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transfer_charter_prices_line_shape CHECK (
    (line_kind = 'destination' AND from_text IS NOT NULL AND to_text IS NOT NULL)
    OR (line_kind = 'extra_day' AND from_text IS NULL AND to_text IS NULL)
  )
);

-- Одно направление — одна цена на тип машины; одна доплата за день на тип.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_charter_prices_destination
  ON transfer_charter_prices (partner_id, vehicle_kind, from_text, to_text)
  WHERE line_kind = 'destination';
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_charter_prices_extra_day
  ON transfer_charter_prices (partner_id, vehicle_kind)
  WHERE line_kind = 'extra_day';
CREATE INDEX IF NOT EXISTS idx_transfer_charter_prices_partner
  ON transfer_charter_prices (partner_id) WHERE is_active;

INSERT INTO partners (
  slug, name, category,
  short_description, description,
  contact, contacts, location,
  hero_image, gallery, video_url, video_poster_url,
  rating, review_count, is_verified, is_public, created_at
)
SELECT
  'shatun',
  'Шатун',
  'transfer',
  'Вахтовки на базе КамАЗ на 26 мест под заказ: Авачинский, Горелый, Вачкажец, Курильское озеро, Толбачик.',
  'Перевозчик: две вахтовки на базе КамАЗ, по 26 посадочных мест. Работает под заказ, целой машиной: '
    || 'цены за машину по прайсу 2026 года для поездок из Петропавловска-Камчатского, при расчёте наличными. '
    || 'Ведар оплату не принимает: заказ и расчёт — напрямую с перевозчиком по телефону, в WhatsApp или Telegram.',
  jsonb_build_object('phone', '+79294560102'),
  jsonb_build_object(
    'phone', '+79294560102',
    'telegram_contact', '+79294560102',
    'whatsapp', '79294560102'
  ),
  jsonb_build_object('region', 'Камчатский край'),
  '/images/shatun/shatun-01.jpg',
  jsonb_build_array(
    '/images/shatun/shatun-02.jpg', '/images/shatun/shatun-03.jpg', '/images/shatun/shatun-04.jpg',
    '/images/shatun/shatun-05.jpg', '/images/shatun/shatun-06.jpg', '/images/shatun/shatun-07.jpg',
    '/images/shatun/shatun-08.jpg', '/images/shatun/shatun-09.jpg', '/images/shatun/shatun-10.jpg',
    '/images/shatun/shatun-11.jpg', '/images/shatun/shatun-12.jpg', '/images/shatun/shatun-13.jpg',
    '/images/shatun/shatun-14.jpg', '/images/shatun/shatun-15.jpg', '/images/shatun/shatun-16.jpg',
    '/images/shatun/shatun-17.jpg', '/images/shatun/shatun-18.jpg', '/images/shatun/shatun-19.jpg',
    '/images/shatun/shatun-20.jpg', '/images/shatun/shatun-21.jpg', '/images/shatun/shatun-22.jpg',
    '/images/shatun/shatun-23.jpg'
  ),
  '/video/shatun/shatun-river-crossing.mp4',
  '/video/shatun/shatun-river-crossing.poster.jpg',
  0, 0, FALSE, TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM partners WHERE slug = 'shatun');

INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats)
SELECT p.id, 'vahtovka', v.title, 26
  FROM partners p
  CROSS JOIN (VALUES
    ('Вахтовка на базе КамАЗ (синяя кабина)'),
    ('Вахтовка на базе КамАЗ (оранжевая кабина)')
  ) AS v(title)
 WHERE p.slug = 'shatun'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_fleet_vehicles f
      WHERE f.partner_id::text = p.id::text AND f.title = v.title
   );

INSERT INTO transfer_charter_prices
  (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub, price_note, conditions, valid_year, sort_order)
SELECT p.id, 'vahtovka', 'destination', 'Петропавловск-Камчатский', v.to_text, v.price_rub, v.price_note,
       'при расчёте наличными', 2026, v.sort_order
  FROM partners p
  CROSS JOIN (VALUES
    ('Вулкан Авачинский',      65000,  NULL::text,           10),
    ('Вулкан Горелый',         75000,  NULL::text,           20),
    ('Вачкажец',               70000,  NULL::text,           30),
    ('Курильское озеро',       450000, 'плюс переправы',     40),
    ('Толбачик (Мёртвый лес)', 360000, NULL::text,           50)
  ) AS v(to_text, price_rub, price_note, sort_order)
 WHERE p.slug = 'shatun'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_charter_prices c
      WHERE c.partner_id::text = p.id::text AND c.vehicle_kind = 'vahtovka' AND c.line_kind = 'destination'
        AND c.from_text = 'Петропавловск-Камчатский' AND c.to_text = v.to_text
   );

INSERT INTO transfer_charter_prices
  (partner_id, vehicle_kind, line_kind, price_rub, price_note, conditions, valid_year, sort_order)
SELECT p.id, 'vahtovka', 'extra_day', 30000, 'при эксплуатации транспорта на местности',
       'при расчёте наличными', 2026, 100
  FROM partners p
 WHERE p.slug = 'shatun'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_charter_prices c
      WHERE c.partner_id::text = p.id::text AND c.vehicle_kind = 'vahtovka' AND c.line_kind = 'extra_day'
   );

-- Исход называется вслух: ровно один партнёр, две машины, шесть строк прайса.
DO $$
DECLARE
  v_partner int;
  v_cars    int;
  v_prices  int;
BEGIN
  SELECT count(*) INTO v_partner FROM partners WHERE slug = 'shatun' AND category = 'transfer';
  SELECT count(*) INTO v_cars FROM transfer_fleet_vehicles f JOIN partners p ON p.id::text = f.partner_id::text
   WHERE p.slug = 'shatun' AND f.is_active;
  SELECT count(*) INTO v_prices FROM transfer_charter_prices c JOIN partners p ON p.id::text = c.partner_id::text
   WHERE p.slug = 'shatun' AND c.is_active;
  IF v_partner <> 1 OR v_cars <> 2 OR v_prices <> 6 THEN
    RAISE WARNING '[1185] «Шатун»: партнёров %, машин % (нужно 2), строк прайса % (нужно 6); запись могла быть заведена раньше из админки', v_partner, v_cars, v_prices;
  END IF;
END $$;

COMMIT;
