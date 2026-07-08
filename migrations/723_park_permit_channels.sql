-- Migration 723: каналы получения разрешений у парков + Вачкажец (issue #367)
--
-- Портал visitkamchatka.ru называет четыре канала получения разрешения:
-- офис, email, gosuslugi41.ru, приложение «Зелёная кнопка». Структуры для
-- них у parks не было — только одиночный permit_url.
--
-- ВАЖНО (правило НЕ ВРАТЬ): конкретные адреса/email/ссылки каналов в
-- issue #367 отсутствуют, из песочницы портал недоступен — колонки
-- добавляются ПУСТЫМИ. Заполнение — владельцем/импортом после сверки
-- с актуальными страницами парков. UI показывает только непустые каналы.
--
-- Вачкажец — памятник природы с отдельным разрешением (issue #367),
-- в справочнике parks его не было. Зона не указана — в наших зонах
-- (avachinsky/western/eastern/northern) его принадлежность не подтверждена.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE parks ADD COLUMN IF NOT EXISTS permit_email          VARCHAR(255);
ALTER TABLE parks ADD COLUMN IF NOT EXISTS permit_office_address TEXT;
ALTER TABLE parks ADD COLUMN IF NOT EXISTS permit_office_hours   TEXT;
ALTER TABLE parks ADD COLUMN IF NOT EXISTS permit_gosuslugi_url  TEXT;
ALTER TABLE parks ADD COLUMN IF NOT EXISTS permit_online_url     TEXT;

INSERT INTO parks (slug, display_name, description, zone, mchs_phone, permit_url, search_term)
VALUES (
  'vachkazhets',
  'Памятник природы «Вачкажец»',
  'Горный массив с цирками, водопадами и озером Тахколоч. Памятник природы — посещение требует отдельного разрешения.',
  NULL,
  NULL,
  NULL,
  'Вачкажец'
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
