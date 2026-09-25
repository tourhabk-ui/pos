-- 1014: регистрация группы в МЧС ссылается на бронь ОПЕРАТОРА.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- Миграция 017 завела mchs_registrations.booking_id UUID REFERENCES
-- bookings(id) — старую таблицу броней. Кабинет оператора живёт на
-- operator_bookings, где id — BIGINT. Роут /api/operator/mchs/register
-- требовал UUID брони (Zod .uuid()) и тут же сверял его с
-- operator_bookings.id (bigint): uuid-строка против bigint — 22P02 на каждом
-- запросе. Форма в кабинете просила «UUID бронирования», которого у брони
-- оператора нет вовсе. Итог: ни одна запись через этот путь создаться не
-- могла — не иногда, а никогда.
--
-- ── Почему новая колонка, а не смена типа booking_id ─────────────────────
-- Сменить тип booking_id (uuid -> bigint) без потери нельзя: uuid в число не
-- приводится, и если в таблице есть хоть одна строка (записанная когда-то
-- другим путём по старой bookings), ALTER ... TYPE упал бы или потребовал
-- выдумать значение. Проверить содержимое прод-таблицы из репозитория нечем
-- (baseline несёт только схему), поэтому выбран путь, безопасный при ЛЮБОМ
-- содержимом: старая колонка остаётся как есть (nullable, история), рядом
-- заводится operator_booking_id BIGINT с FK на operator_bookings, и новый
-- код пишет только в неё. Ничего не удаляется и не переписывается.
--
-- ON DELETE SET NULL: запись о регистрации группы в МЧС — след безопасности,
-- удаление брони не должно стирать его вместе с составом группы.

ALTER TABLE mchs_registrations
  ADD COLUMN IF NOT EXISTS operator_booking_id BIGINT
    REFERENCES operator_bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mchs_registrations_operator_booking_id
  ON mchs_registrations(operator_booking_id);

COMMENT ON COLUMN mchs_registrations.operator_booking_id IS
  'Бронь оператора (operator_bookings.id, bigint), по которой регистрируется группа. Пишет /api/operator/mchs/register.';

COMMENT ON COLUMN mchs_registrations.booking_id IS
  'УСТАРЕЛО: ссылка на старую таблицу bookings (uuid) из миграции 017. Новый код пишет operator_booking_id.';
