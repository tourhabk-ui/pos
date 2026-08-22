-- Migration 906: вернуть operator_bookings колонки, которые числятся
-- существующими, но которых на боевой базе нет.
--
-- ФАКТ (снят с прода 22.08.2026 10:31 UTC, GET /api/cron/schema-audit,
-- проба 90): у operator_bookings 47 колонок. Миграции объявляют 52. Пять
-- колонок объявлены и отсутствуют:
--
--   reseller_reference  ← 062_octo_reseller_reference.sql
--   tour_id             ← 065_hotfix_missing_columns.sql
--   total_amount        ← 065_hotfix_missing_columns.sql
--   admin_notes         ← 126_agent_action_tables.sql
--   user_id             ← 132_bookings_tours_compat_views.sql
--
-- При этом в том же ответе "unapplied": [] и "failures": [] — база считает
-- применёнными ВСЕ файлы образа, включая 062, 065, 126 и 132.
--
-- Как «применено» уживается с «колонки нет». Каждый файл идёт одной
-- транзакцией: падение любого оператора откатывает файл целиком, а запись
-- в _migrations при этом всё равно делалась — дефект трекинга, разобранный
-- отдельно (задача #58, «ROLLBACK файла записывается как applied»). В
-- раннере он починен, но следы старых откатов остались в базе, и аудит по
-- ИМЕНАМ файлов их не видит: имя есть, действия нет.
--
-- Чем именно падал каждый файл — восстановить нельзя, текста ошибки того
-- прогона не сохранилось (_migration_failures завели позже). Улика есть
-- только у 065: он заканчивается вставкой в ai_actions_log колонками
-- agent_id и status, а в снимке прода у ai_actions_log таких колонок нет
-- (action_type, metadata, created_at, provider, user_id, tokens_in,
-- tokens_out, cost_usd). Для 132 причина следует из порядка: он строит
-- представление bookings по tour_id и weather_dependent, которых после
-- отката 065 не существует. Про 062 и 126 сказать нечего — не знаю.
--
-- ЧТО ЭТО СТОИЛО. user_id читают и пишут около тридцати мест: кабинет
-- туриста (/api/bookings/my, ваучер, календарь, отказ от претензий),
-- список клиентов оператора, отчёты, напоминания. Четыре из семи путей
-- создания брони перечисляют user_id в списке колонок — /api/bookings/tour,
-- /api/tours/[id]/book, /api/hub/bookings/create и
-- lib/services/tours/booking.service.ts — то есть бронь с сайта на проде
-- не создавалась вовсе. Бронь через Кузьмича и кабинет оператора user_id
-- не пишут и работали. reseller_reference — ключ идемпотентности OCTO:
-- без него канал перепродажи падал и на вставке, и на поиске дубля.
-- admin_notes пишет initiative-executor, помечая подозрительную оплату.
--
-- tour_id и total_amount НЕ восстанавливаются намеренно. tour_id дублировал
-- operator_tour_id (NOT NULL, внешний ключ, все индексы) — вторая колонка
-- того же смысла это будущее расхождение; ссылки на неё в коде переписаны
-- на operator_tour_id. total_amount не читает никто: единственное
-- упоминание — таблица замен в lib/agents/tools/board-executor-tools.ts,
-- которая переводит его в final_price.

BEGIN;

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_user_id
  ON operator_bookings(user_id) WHERE user_id IS NOT NULL;

-- Идемпотентность OCTO: пара (reseller_reference, octo_api_key_id) уникальна
-- в пределах ключа партнёра, а не глобально — как и задумано в 062.
ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS reseller_reference VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_bookings_reseller_reference_per_api_key
  ON operator_bookings(reseller_reference, octo_api_key_id)
  WHERE reseller_reference IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_reseller_reference
  ON operator_bookings(reseller_reference)
  WHERE reseller_reference IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

COMMIT;
