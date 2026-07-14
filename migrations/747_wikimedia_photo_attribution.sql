-- 747_wikimedia_photo_attribution.sql
--
-- Реальные фото мест из Wikimedia Commons (CC-лицензии) требуют атрибуции:
-- автор + название лицензии + ссылки. Храним их прямо в ai_route_images,
-- чтобы credit можно было показать на карточке места (требование CC-BY / CC-BY-SA).
--
-- Все колонки nullable — у AI-сгенерированных и ручных загрузок атрибуции нет.
-- Идемпотентно.

ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS source_url  TEXT;  -- ссылка на страницу файла на Commons
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS author      TEXT;  -- автор снимка (из extmetadata Artist)
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS license     TEXT;  -- короткое имя лицензии (CC BY-SA 4.0, CC0, ...)
ALTER TABLE ai_route_images ADD COLUMN IF NOT EXISTS license_url TEXT;  -- ссылка на текст лицензии

COMMENT ON COLUMN ai_route_images.source_url  IS 'Источник фото (для model=wikimedia — страница файла на Commons)';
COMMENT ON COLUMN ai_route_images.author      IS 'Автор фото — обязателен для показа при CC-BY / CC-BY-SA';
COMMENT ON COLUMN ai_route_images.license     IS 'Короткое имя лицензии (CC BY-SA 4.0, CC0 1.0, Public domain)';
COMMENT ON COLUMN ai_route_images.license_url IS 'Ссылка на текст лицензии';
