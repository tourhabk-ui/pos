-- 1317: прокат автомобилей — схема витрины /car-rental.
--
-- Решение владельца 23.10: «пока берем аренду автомобилей и трансфер» (группа
-- «Лагуна»). До этого дня проката на платформе не было: планер отвечал
-- «аренды автомобилей на платформе пока нет» (решение 26.09), и это было
-- правдой. Первый прокатчик — «Лагуна Прокат», данные в 1318.
--
-- ── Прокат — не перевозчик ────────────────────────────────────────────────
--
-- Перевозчик (§14) везёт: машина целиком с водителем, цена за машину на
-- направление или за время работы. Прокат сдаёт машину БЕЗ водителя: цена —
-- за сутки за машину, куда ехать и на сколько дней — решает арендатор, а
-- водитель бывает только «по желанию, цена отдельно» (driver = optional).
-- Писать это в прайс перевозчика значило бы назвать самостоятельную поездку
-- перевозкой; поэтому своя таблица предложений и своя таблица условий.
--
-- Прокатчик — партнёр, у которого есть живая строка здесь (как перевозчик —
-- партнёр с живой строкой прайса машин): отдельной роли и категории не
-- заводится, один партнёр может стоять на обеих витринах.
--
-- ── Что записывается, чего НЕТ (§4.0) ─────────────────────────────────────
--
--   • title, body_kind — машина и её род (легковая / внедорожник /
--     микроавтобус / вездеход / вахтовка); seats, transmission, drive,
--     engine_hp — NULL, когда прокатчик не назвал.
--   • price_rub_per_day — целые рубли за сутки за машину; price_is_from —
--     прокатчик пишет «от», точную цену называет сам.
--   • deposit_rub — залог; NULL — не записан, не «залога нет».
--   • driver: 'self' — только без водителя; 'optional' — водитель по
--     желанию, цена водителя отдельно и здесь не записана.
--   • conditions — условия именно этой строки словами прокатчика;
--     source_url и prices_seen_on — откуда цена и когда сверена.
--   • car_rental_terms.items — условия прокатчика пунктами, его словами.
--   • Минимальный срок, возраст и стаж водителя, что входит в цену,
--     страховка, год и пробег машины — колонок НЕТ: страница говорит
--     «на платформе не записано — уточняется у прокатчика», а не выдумывает.
--   • Оплаты через платформу нет; заявка — лид прокатчику и менеджеру.
--
-- Идемпотентна: таблицы и индекс — IF NOT EXISTS. CONCURRENTLY нет — файл
-- идёт в транзакции.

BEGIN;

CREATE TABLE IF NOT EXISTS car_rental_offers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id        UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  title             VARCHAR(120) NOT NULL,
  body_kind         VARCHAR(20) NOT NULL CHECK (body_kind IN ('car', 'suv', 'minibus', 'offroad_truck', 'vahtovka')),
  -- NULL — число мест не записано (не ноль и не догадка).
  seats             INTEGER CHECK (seats IS NULL OR seats > 0),
  transmission      VARCHAR(10) CHECK (transmission IS NULL OR transmission IN ('automatic', 'manual')),
  drive             VARCHAR(5) CHECK (drive IS NULL OR drive IN ('4wd', 'awd', '2wd')),
  engine_hp         INTEGER CHECK (engine_hp IS NULL OR engine_hp > 0),
  -- Целые рубли за сутки за машину. Строка без цены — не прайс.
  price_rub_per_day INTEGER NOT NULL CHECK (price_rub_per_day > 0),
  -- «от»: точную цену называет прокатчик.
  price_is_from     BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL — залог не записан, а не «залога нет».
  deposit_rub       INTEGER CHECK (deposit_rub IS NULL OR deposit_rub > 0),
  -- 'self' — без водителя; 'optional' — водитель по желанию, цена отдельно.
  driver            VARCHAR(10) NOT NULL CHECK (driver IN ('self', 'optional')),
  conditions        TEXT,
  source_url        TEXT,
  prices_seen_on    DATE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT car_rental_offers_partner_title UNIQUE (partner_id, title)
);

CREATE INDEX IF NOT EXISTS idx_car_rental_offers_partner
  ON car_rental_offers (partner_id) WHERE is_active;

COMMENT ON TABLE car_rental_offers IS
  'Прокат автомобилей (1317): машина без водителя, цена за сутки за машину; прокатчик — партнёр с живой строкой здесь';
COMMENT ON COLUMN car_rental_offers.driver IS
  'self — только без водителя; optional — водитель по желанию, цена водителя отдельно и не записана';
COMMENT ON COLUMN car_rental_offers.price_is_from IS
  'TRUE — прокатчик пишет «от», точную цену называет сам';
COMMENT ON COLUMN car_rental_offers.deposit_rub IS
  'Залог, ₽; NULL — не записан, а не «залога нет»';

-- Условия прокатчика пунктами, его словами. Пустой список — не условия, а
-- мусор: его не пускает проверка; «условий не записано» — отсутствие строки.
CREATE TABLE IF NOT EXISTS car_rental_terms (
  partner_id  UUID PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  items       TEXT[] NOT NULL CHECK (cardinality(items) >= 1),
  source_url  TEXT,
  seen_on     DATE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE car_rental_terms IS
  'Условия проката партнёра пунктами (1317); нет строки — «условия на платформе не записаны»';

COMMIT;
