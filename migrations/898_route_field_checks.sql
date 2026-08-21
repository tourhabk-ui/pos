-- 898: полевая проверка записей — улика от человека, который стоит на месте.
--
-- Владелец 21.08: «знакомая едет на Вилючинский перевал и все места рядом,
-- нужна форма для проверки маршрутов». До сих пор машина умела только
-- судить данные сама (переписи имён, описаний, линий), а полевая правда
-- приходила текстом в чат — координаты Диких озерков, GPX Трёх Братьев —
-- и переносилась руками. Это не масштабируется и теряется.
--
-- Проверка НЕ меняет данные. Она кандидат на решение человека — тот же
-- закон, что у переписей: судья предлагает, правит владелец. Отсюда
-- status и отсутствие любых триггеров на master-таблицы.
--
-- Третье состояние в каждом поле: точность фикса может быть неизвестна
-- (accuracy_m NULL — телефон её не дал), координата может отсутствовать
-- (проверяли по памяти, не на месте), заметка необязательна. Пустое
-- поле — честное «не знаю», а не ноль.
--
-- Персональных данных не собираем: вместо имени — метка выхода
-- («полевой выход 22.08»), чтобы связать пачку проверок одного дня.

CREATE TABLE IF NOT EXISTS route_field_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Что проверяли: маршрут или место. Тип хранится строкой, FK нет
  -- намеренно — id живут в двух таблицах (см. 685: inline-FK на places
  -- уже ронял миграцию), целостность держит прикладной слой.
  target_kind   VARCHAR(8) NOT NULL CHECK (target_kind IN ('route', 'place')),
  target_id     TEXT NOT NULL,
  -- Вердикт проверяющего. 'confirmed' — всё сходится; остальное называет,
  -- ЧТО именно расходится, чтобы правка знала, куда смотреть.
  verdict       VARCHAR(20) NOT NULL CHECK (verdict IN (
                  'confirmed', 'coords_wrong', 'not_found',
                  'line_wrong', 'description_wrong', 'access_changed', 'other')),
  -- Координата с телефона проверяющего и точность фикса. NULL — проверка
  -- не с места (это законно и должно быть видно тому, кто будет решать).
  reported_lat  DECIMAL(9,6),
  reported_lng  DECIMAL(9,6),
  accuracy_m    INTEGER CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  note          TEXT CHECK (note IS NULL OR char_length(note) <= 600),
  -- Метка выхода, не имя: связывает проверки одной поездки.
  trip_tag      VARCHAR(60),
  status        VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Разбор очереди: что ещё не рассмотрено, свежее сверху.
CREATE INDEX IF NOT EXISTS idx_route_field_checks_status_created
  ON route_field_checks (status, created_at DESC);

-- История по объекту: все проверки одной записи.
CREATE INDEX IF NOT EXISTS idx_route_field_checks_target
  ON route_field_checks (target_kind, target_id);
