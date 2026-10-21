-- Migration 1304: класс устройства у просмотра страницы
-- Created: 2026-10-21
--
-- Владелец 21.10: «круто бы при нажатии на количество визитов открывалась бы
-- расширенная статистика». Источник (referrer) и страница входа уже пишутся,
-- устройства не было. Храним только класс — mobile / tablet / desktop,
-- вычисленный из User-Agent при записи; сам UA по-прежнему не сохраняется
-- (152-ФЗ, тот же подход, что у суточного visitor_hash). Задним числом
-- класса нет: старые строки остаются NULL, экран называет дату начала.

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS device TEXT;

-- Rollback:
-- ALTER TABLE page_views DROP COLUMN IF EXISTS device;
