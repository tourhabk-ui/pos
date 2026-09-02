-- 926: трансферы под заказ — парк, поездки и места в них.
--
-- ── Почему заново, а не «восстановить» ─────────────────────────────────────
--
-- Перепись реестра схемы 01.09 (GET /api/cron/schema-registry-census, прогон 2,
-- канарейка видна) показала: на проде НЕТ ни одной из восьми таблиц прежнего
-- модуля трансферов, как нет и `operators`. Приложение на любом обращении к ним
-- получает 42P01. Файл `lib/database/transfer_schema.sql` не применялся никогда
-- и вдобавок неполон — в нём нет трёх колонок, которые спрашивает код
-- (payment_status, seats_count, transfer_id).
--
-- Источника истины не было ни одного: ни на проде, ни в файле. Восстанавливать
-- нечего, поэтому схема проектируется заново под то, как работа устроена на
-- самом деле (решение владельца 01.09).
--
-- ── Как устроена работа ────────────────────────────────────────────────────
--
-- Расписаний нет по природе дела: джипы и вахтовки ходят ПОД ЗАКАЗ — «есть
-- заказы, туда и едут». У перевозчика есть ПАРК: машины с местами. Заказывает
-- чаще туроператор, который везёт группу, и направление задаёт он.
--
-- Но машина не всегда уходит под одну группу целиком: если вахтовка идёт на
-- Горелый и места остались, их выставляют в витрину. Поэтому «заказ» — не одна
-- сущность, а две: ПОЕЗДКА (машина, дата, направление, сколько мест всего) и
-- МЕСТА В НЕЙ, которые могут занять разные заказчики.
--
-- ── Почему `transfer_seat_bookings`, а не `transfer_bookings` ──────────────
--
-- Имя `transfer_bookings` занято мёртвым кодом: два десятка роутов и семь
-- страниц прежнего модуля обращаются к нему с колонками, которых в новой схеме
-- нет (schedule_id, seats_count, transfer_id). Если завести таблицу под тем же
-- именем, их запросы перестанут падать на «нет таблицы» (42P01) и начнут падать
-- на «нет колонки» (42703) — то есть сломанное станет выглядеть менее сломанным,
-- а сигнал «этот код мёртв» пропадёт. Мёртвый код удаляется отдельным заходом;
-- до тех пор новые таблицы носят собственные имена и ни с чем не сливаются.
--
-- ── Что здесь делает база, а не код ────────────────────────────────────────
--
-- Занятость машины не хранится отдельно: она выводится из поездок, а две
-- поездки одной машины на один день запрещает частичный уникальный индекс.
-- Прецедент репозитория — idx_agent_tasks_active_resource (917): check-then-act
-- проигрывает гонку, уникальный индекс не проигрывает.

CREATE TABLE IF NOT EXISTS transfer_fleet_vehicles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id    UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Тип техники решает проходимость, а не комфорт: до Мутновского и Толбачика
  -- едут вахтовкой, а не джипом. Список закрытый — «прочее» есть, но названо.
  kind          VARCHAR(20) NOT NULL CHECK (kind IN ('jeep', 'vahtovka', 'minibus', 'other')),
  title         VARCHAR(255) NOT NULL,
  seats         INTEGER NOT NULL CHECK (seats > 0),
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_fleet_vehicles_partner
  ON transfer_fleet_vehicles(partner_id) WHERE is_active;

-- Поездка: машина едет в такую-то дату туда-то. Заводит её перевозчик — сам
-- (плановый выезд) либо приняв заказ туроператора.
CREATE TABLE IF NOT EXISTS transfer_trips (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id        UUID NOT NULL REFERENCES transfer_fleet_vehicles(id) ON DELETE RESTRICT,
  trip_date         DATE NOT NULL,
  from_text         VARCHAR(255) NOT NULL,
  to_text           VARCHAR(255) NOT NULL,

  -- Цель может быть точкой или маршрутом платформы — тогда поездка связана с
  -- безопасностью (сезонность дороги, регистрация МЧС), а не висит отдельной
  -- строкой. Оба поля NULL-able: везут и туда, чего у нас в базе нет, а
  -- принуждать выбрать из справочника значило бы заставить выдумать.
  --
  -- to_place_id — TEXT без FK (правка 02.09). Исходная строка
  -- `UUID REFERENCES places(id)` не применялась НИ РАЗУ: 31 попытка на проде,
  -- ответ сервера — «foreign key constraint transfer_trips_to_place_id_fkey
  -- cannot be implemented». Это текст ошибки, которого не было у 675 и 685:
  -- там между двумя гипотезами не выбирали, здесь выбор сделан сервером —
  -- ТИПЫ НЕ СОВПАДАЮТ, places.id на проде TEXT, UUID у места лежит в ark_id.
  -- Приводим к типу родителя и снимаем inline-FK, как в 675/685/737:
  -- целостность держит прикладной слой. Пока строка стояла, ни одной таблицы
  -- трансферов на проде не было, а код поверх них считал, что они есть.
  to_place_id       TEXT,
  to_route_id       UUID REFERENCES kamchatka_routes(id),

  -- Время отправления — ЗАМЕТКА, а не TIME. Говорят «рано утром», «к шести»,
  -- «после прилёта»; колонка TIME заставила бы выдумать точность, которой в
  -- договорённости нет (§4.0).
  departure_note    VARCHAR(100),

  -- Сколько мест В ЭТОЙ поездке. Отдельно от vehicles.seats намеренно: часть
  -- мест занимает снаряжение группы, и перевозчик вправе выставить меньше,
  -- чем вмещает машина. Больше — нельзя, это держит приложение (сверка двух
  -- таблиц в CHECK не выражается).
  seats_total       INTEGER NOT NULL CHECK (seats_total > 0),

  -- NULL = цена места не назначена: поездка не продаётся поштучно (ушла под
  -- одну группу). Ноль вместо NULL был бы враньём о бесплатном месте.
  price_per_seat    NUMERIC(10,2) CHECK (price_per_seat IS NULL OR price_per_seat > 0),

  -- Витрина. Публикуется явным решением перевозчика, а не автоматически по
  -- наличию мест: свободное место и ГОТОВНОСТЬ взять попутчика — разные вещи.
  is_published      BOOLEAN NOT NULL DEFAULT false,

  status            VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'confirmed', 'cancelled', 'completed')),
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Одна машина — одна живая поездка на дату. Запрет держит БД: проверка в коде
-- проигрывает гонку двух туроператоров, целящихся в одну вахтовку на один день.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_trips_vehicle_day
  ON transfer_trips(vehicle_id, trip_date)
  WHERE status IN ('planned', 'confirmed');

-- Витрина спрашивает «что едет в такие-то дни» — по дате и признаку публикации.
CREATE INDEX IF NOT EXISTS idx_transfer_trips_published
  ON transfer_trips(trip_date, status) WHERE is_published;

-- Места в поездке. Одну поездку могут делить туроператор с группой и
-- одиночные туристы, купившие остаток.
CREATE TABLE IF NOT EXISTS transfer_seat_bookings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id               UUID NOT NULL REFERENCES transfer_trips(id) ON DELETE CASCADE,

  -- Заказчик — ЛИБО туроператор (везёт группу), ЛИБО турист сам. Ровно один из
  -- двух: заказ без заказчика бессмыслен, с двумя — неразрешимый вопрос «кому
  -- счёт». Держит CHECK, а не договорённость в коде.
  ordered_by_partner_id UUID REFERENCES partners(id),
  ordered_by_user_id    UUID REFERENCES users(id),
  CONSTRAINT transfer_seat_bookings_one_customer
    CHECK (num_nonnulls(ordered_by_partner_id, ordered_by_user_id) = 1),

  seats                 INTEGER NOT NULL CHECK (seats > 0),

  -- NULL = цена ещё не названа. Законное состояние: перевозчик называет её,
  -- увидев направление и число людей.
  price                 NUMERIC(10,2) CHECK (price IS NULL OR price > 0),

  status                VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled')),
  decline_reason        TEXT,
  comment               TEXT,
  contact_phone         VARCHAR(20),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_seat_bookings_trip
  ON transfer_seat_bookings(trip_id, status);

CREATE INDEX IF NOT EXISTS idx_transfer_seat_bookings_partner
  ON transfer_seat_bookings(ordered_by_partner_id, created_at DESC)
  WHERE ordered_by_partner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transfer_seat_bookings_user
  ON transfer_seat_bookings(ordered_by_user_id, created_at DESC)
  WHERE ordered_by_user_id IS NOT NULL;
