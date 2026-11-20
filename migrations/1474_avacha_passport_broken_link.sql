-- 1474: ссылка на паспорт маршрута «Восхождение на Авачинский вулкан» на сайте
-- парка (vulcanikamchatki.ru/files/pasport_7_…pdf) отдаёт 500 — проверено
-- 21.11.2026 и с www, и без; страница номеров маршрутов парка ссылается на тот же
-- битый файл. Ссылку убираем из passport_urls; трек (zip, 200) и страница
-- источника (200) остаются. Идемпотентно: повтор ничего не меняет.
UPDATE park_approved_routes
   SET passport_urls = array_remove(passport_urls, 'https://www.vulcanikamchatki.ru/files/pasport_7_voshozhdenie_na_avachinskij_vulkan.pdf')
 WHERE 'https://www.vulcanikamchatki.ru/files/pasport_7_voshozhdenie_na_avachinskij_vulkan.pdf' = ANY(passport_urls);
