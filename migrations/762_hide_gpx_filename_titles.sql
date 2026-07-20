-- 762_hide_gpx_filename_titles.sql
--
-- Editor-прогон (2026-07-20) «улучшил описание» записи с заголовком
-- «fjckwmeuvdpsnilh.gpx» — это не место и не маршрут, а сырое имя
-- GPX-файла, протёкшее в title при каком-то bulk-импорте трека (fallback
-- на имя файла, когда в GPX нет <name>). Такая запись-фантом вылезает в
-- поиске/листингах как «сломанный» маршрут и подрывает доверие к каталогу,
-- а Editor ещё и жёг на неё токены.
--
-- Прячем весь класс: ни одно реальное камчатское место/маршрут не
-- называется «X.gpx». Не удаляем (вдруг под мусорным заголовком реальный
-- трек с геометрией) — скрываем до ручного переименования, как прецеденты
-- 749/758. Идемпотентна: трогает только видимые .gpx-заголовки.

UPDATE kamchatka_routes
   SET is_visible = FALSE, updated_at = NOW()
 WHERE title ILIKE '%.gpx' AND is_visible = TRUE;

UPDATE places
   SET is_visible = FALSE, updated_at = NOW()
 WHERE name ILIKE '%.gpx' AND is_visible = TRUE;
