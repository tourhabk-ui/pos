-- 1485: правки Сыщика 21.11, сверенные по первоисточникам.
--
-- 1. Маршрут «Вулкан Мутновский» (/routes/vulkan-mutnovskiy-874283be): снято
--    «самый доступный маршрут „заглянуть внутрь действующего вулкана“» и
--    «организует Министерство туризма, летний сезон». Маршрут закрыт: знаки о
--    запрете спуска в кратер стоят с 2022 года (Кам 24, 28.07.2022), 11.08.2026
--    сеть природных парков открыла летние маршруты Южно-Камчатского парка, кроме
--    вулкана Мутновский (vulcanikamchatki.ru). Плашка о закрытии с источниками —
--    lib/routes/closures.ts.
-- 2. Тур «Автомобильный тур на Курильское озеро» (volcanoesland): «самая большая
--    популяция бурого медведя в мире» → формулировка Кроноцкого заповедника
--    («самая большая охраняемая популяция этих хищников на Камчатке»); «от 3 до
--    10 миллионов особей нерки» → «в последние годы — до 1,7 млн особей» (там же,
--    kronoki.ru/ru/visit/information-for-all/excursions/155.html).
--
-- Точечные replace; повтор ничего не меняет, updated_at двигается только у
-- изменённых строк.

CREATE OR REPLACE FUNCTION pg_temp.mutnovsky_fix(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(t,
    'Самый доступный маршрут «заглянуть внутрь действующего вулкана» Камчатки. ', ''),
    'Организует Министерство туризма Камчатского края, летний сезон.',
    'Маршрут закрыт: знаки о запрете спуска в кратер стоят с 2022 года, а 11.08.2026 природный парк открыл летние маршруты Южно-Камчатского парка, кроме вулкана Мутновский.')
$$;

UPDATE kamchatka_routes
   SET description = pg_temp.mutnovsky_fix(description), updated_at = NOW()
 WHERE (slug = 'vulkan-mutnovskiy-874283be' OR id::text = '874283be-6572-40c6-ac4e-7210f090b7a1')
   AND description IS DISTINCT FROM pg_temp.mutnovsky_fix(description);

CREATE OR REPLACE FUNCTION pg_temp.kurile_fix(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(t,
    'здесь обитает самая большая популяция бурого медведя в мире и каждый год нерестится от 3 до 10 миллионов особей нерки',
    'в Южно-Камчатском заказнике обитает самая большая охраняемая популяция бурого медведя на Камчатке, а нерки в озеро в последние годы заходит до 1,7 млн особей')
$$;

UPDATE operator_tours
   SET description       = pg_temp.kurile_fix(description),
       short_description = pg_temp.kurile_fix(short_description),
       updated_at        = NOW()
 WHERE slug = 'volcanoesland-avtotur-kurilskoe-ozero'
   AND (description IS DISTINCT FROM pg_temp.kurile_fix(description)
        OR short_description IS DISTINCT FROM pg_temp.kurile_fix(short_description));
