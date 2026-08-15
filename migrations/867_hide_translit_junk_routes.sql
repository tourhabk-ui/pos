-- 867_hide_translit_junk_routes.sql
--
-- Партия 1 уборки маршрутов: транслит-мусор уходит с витрины.
--
-- Перепись 15.08 (проба 51, data/audit/routes-pain-map-2026-08-15.md):
-- четыре ВИДИМЫХ маршрута носят имена-транслиты KML-файлов инбокса
-- («dachnye istochniki», «ganalskie vostryaki»...) — и при этом у них нет
-- ни трека, ни якоря. KML-инбокс создаёт несопоставленные маршруты
-- СКРЫТЫМИ (правило в lib/import/kml-inbox.ts) — эти четыре оказались на
-- витрине вопреки правилу. Турист видит в каталоге «gornyy massiv
-- vachkazhets» рядом с настоящим «Горный массив Вачкажец».
--
-- Скрываем ТОЧНО по имени и только записи без геометрии: если у записи
-- к моменту прогона появился трек — она уже не мусор, не трогаем.
-- Обратимо (is_visible), идемпотентно.

UPDATE kamchatka_routes SET is_visible = false, updated_at = NOW()
 WHERE title IN (
   'dachnye istochniki',
   'ganalskie vostryaki',
   'gornyy massiv vachkazhets',
   'mayak petropavlovskiy mys vertikalnyy'
 )
   AND is_visible = true
   AND geometry IS NULL;

INSERT INTO _migrations (name)
VALUES ('867_hide_translit_junk_routes.sql')
ON CONFLICT (name) DO NOTHING;
