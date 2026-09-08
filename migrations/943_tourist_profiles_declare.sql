-- 943_tourist_profiles_declare.sql
--
-- Таблицы `tourist_profiles` НЕТ НА ПРОДЕ, и это не догадка: Watchdog 08.09
-- принёс от крона Document Expiry дословное `relation "tourist_profiles" does
-- not exist`, при том что успешных прогонов у этого крона нет ВООБЩЕ за всю
-- историю. То есть напоминания об истечении документов туриста не работали
-- никогда — ни разу с момента заведения.
--
-- Таблица числилась в замороженном списке KNOWN_UNDECLARED
-- (tests/unit/schema-coverage.test.ts): тридцать таблиц, чью форму вывести
-- неоткуда. Продолжение той же истории, что и с `tourist_documents`
-- (миграция 903): дочернюю объявили, родительскую — нет, и внешнего ключа там
-- нет именно поэтому.
--
-- ── Откуда взята форма ─────────────────────────────────────────────────────
--
-- Из ЖИВОГО кода, который с таблицей работает, и ниоткуда больше:
--   app/api/tourist/profile          — UpdateProfileSchema (Zod) даёт имена и
--                                      типы всех редактируемых полей;
--   lib/auth/tourist-helpers         — id, user_id, full_name, total_trips,
--                                      total_spent, loyalty_points;
--   app/api/tourist/stats            — те же счётчики в агрегатах;
--   app/api/tourist/notification-preferences — SELECT id WHERE user_id.
--
-- Ни одной колонки сверх того, что код действительно использует, не
-- придумано. Где тип из кода не следует однозначно (`preferred_group_size`,
-- `budget_range` — в Zod это строки), стоит TEXT: угадать «наверное число»
-- значило бы поставить форму, в которую живой код не запишет.
--
-- ── Про данные ─────────────────────────────────────────────────────────────
--
-- Здесь лежат ПД и медицинские сведения: телефон, адрес, аллергии,
-- ограничения по здоровью, контакт на случай беды, полис. Индексов по ним нет
-- намеренно — искать людей по номеру телефона или диагнозу платформа не
-- должна. Единственный индекс — по user_id, которым профиль и находят.
--
-- Экстренный контакт стоит рядом с медицинскими полями не случайно: это то,
-- что спасателю нужно в первую очередь, и то, ради чего профиль вообще есть.
--
-- IF NOT EXISTS: на инстансе, где таблица уже есть со своей формой, миграция
-- ничего не трогает. На проде она её СОЗДАСТ — там её нет.

CREATE TABLE IF NOT EXISTS tourist_profiles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Один профиль на пользователя: getTouristProfile ищет по user_id и создаёт
  -- недостающий. Без UNIQUE гонка двух запросов завела бы второй профиль, и
  -- дальше «мои поездки» показывали бы то один, то другой.
  user_id       UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name     TEXT,

  -- Кто это (Zod: все строки)
  date_of_birth TEXT,
  gender        TEXT,
  nationality   TEXT,
  phone         TEXT,
  avatar_url    TEXT,
  bio           TEXT,

  -- Чем занимается и что умеет
  languages             TEXT[],
  interests             TEXT[],
  fitness_level         TEXT,
  experience_level      TEXT,
  preferred_group_size  TEXT,
  budget_range          TEXT,
  preferred_seasons     TEXT[],

  -- Здоровье и еда: нужны гиду на маршруте, а не витрине
  dietary_restrictions  TEXT[],
  medical_conditions    TEXT,
  allergies             TEXT,

  -- Кому звонить, если случилась беда
  emergency_contact_name     TEXT,
  emergency_contact_phone    TEXT,
  emergency_contact_relation TEXT,

  -- Где живёт
  home_address     TEXT,
  home_city        TEXT,
  home_country     TEXT,
  home_postal_code TEXT,

  -- Страховка: срок здесь текстом, потому что таким его шлёт форма
  travel_insurance_provider TEXT,
  travel_insurance_policy   TEXT,
  travel_insurance_expiry   TEXT,

  -- Счётчики: их пересчитывает updateTouristStats, поэтому ноль по умолчанию —
  -- честное начальное состояние, а не «данных нет».
  total_trips    INTEGER NOT NULL DEFAULT 0,
  total_spent    NUMERIC NOT NULL DEFAULT 0,
  loyalty_points INTEGER NOT NULL DEFAULT 0,

  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Единственный индекс: им профиль находят по пользователю. UNIQUE выше уже
-- даёт его, поэтому отдельного создавать не нужно — запись здесь для того,
-- чтобы следующий читатель не завёл дубль «на всякий случай».
