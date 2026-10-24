-- Migration 1328: класс просмотра — маяк и семейство, без удаления старых строк
-- Created: 2026-10-24
--
-- Владелец 24.10: цифра визитов за сутки — автопроверки и боты. Новые
-- просмотры помечаются при записи (маяк, webdriver, роль, адрес коробки).
-- Здесь — только колонки, чтобы витрина могла отделить ИИ-краулеров.
--
-- User-Agent в page_views не хранился (152-ФЗ, миграция 778). Переклассифицировать
-- старые строки по нему НЕЧЕМ: обновлять is_bot наугад — выдать догадку за
-- разбор. Строки не удаляются и не переписываются.
--
-- client_beacon у уже лежащих строк — TRUE: единственный писатель таблицы
-- был клиентский маяк. У новых вставок, которые колонку не назовут,
-- умолчание FALSE (служебный вызов — не человек). Приём /api/analytics/hit
-- ставит значение сам.

BEGIN;

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS client_beacon BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE page_views ALTER COLUMN client_beacon SET DEFAULT FALSE;

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS ua_family TEXT;

COMMENT ON COLUMN page_views.client_beacon IS
  'TRUE — строку прислал клиентский маяк. Старые строки TRUE: другого писателя не было. Новые без маяка остаются FALSE, и приём ставит is_bot.';
COMMENT ON COLUMN page_views.ua_family IS
  'Метка семейства из lib/analytics/bot-detect, не сырой User-Agent. NULL — строка старше колонки: User-Agent не хранился, в «ИИ-краулеры» её не перенести.';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE page_views DROP COLUMN IF EXISTS ua_family;
-- ALTER TABLE page_views DROP COLUMN IF EXISTS client_beacon;
-- COMMIT;
