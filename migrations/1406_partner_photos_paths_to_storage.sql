-- Migration 1406: пути снимков партнёров — из папки сайта в хранилище
-- Created: 2026-11-08
--
-- Владелец 08.11: «да и разберись почему грузяться не сразу в s3».
--
-- Снимки десяти партнёров лежали в папке сайта public/images и уезжали в
-- образ: 932 файла, 83 МБ. Раздача из хранилища знала только .jpg, а
-- уменьшенные копии нарезались только из папки сайта. Обе причины сняты в
-- #3150 и #3151. Там же снимки скопированы байт в байт в
-- media/s3/photos/<та же папка>/ и залиты в хранилище с чтением обратно
-- (маркер media-to-s3, прогоны 21 и 22).
--
-- Эта миграция переписывает адреса в базе:
--   /images/<папка>/…  →  /api/images/s3/photos/<папка>/…
-- Папки: fishingkam, kutha, laguna-prokat, mestechko, partners, shatun,
-- tours/bystraya-rafting, volcanoesland, zaporozhets, zheltukhin.
--
-- Что переписывается:
--   - только адрес, который НАЧИНАЕТСЯ с /images/<папка>/: строка целиком,
--     элемент массива, строковое значение или ключ JSON. Полный адрес
--     хранилища вида https://…/images/tours/<id>/… (загрузки операторов из
--     кабинета) не трогается — он не начинается с /images/;
--   - только в таблицах, куда эти адреса писали миграции: operator_tours,
--     partners, transfer_charter_prices, transfer_fleet_vehicles, assets,
--     accommodation_assets, accommodations, car_rental_offers. Колонки
--     перебираются по типу (text, varchar, их массивы, jsonb), а не
--     перечисляются руками: адрес мог попасть в колонку, о которой миграции
--     не знают (правка из админки).
--
-- Что страхует остальное: в next.config.js старый адрес /images/<папка>/…
-- переадресуется на хранилище. Строка в другой таблице, ссылка в старом
-- посте или кэш поисковика снимок не потеряют.
--
-- Повтор ничего не меняет: переписанный адрес начинается с /api/, и шаблон
-- его больше не узнаёт.
--
-- Сторож: tests/integration/operators-list.pg.test.ts (блок 1406).

DO $$
DECLARE
  dirs  CONSTANT text := '(fishingkam|kutha|laguna-prokat|mestechko|partners|shatun|tours/bystraya-rafting|volcanoesland|zaporozhets|zheltukhin)';
  re    CONSTANT text := '^/images/' || dirs || '/';
  jre   CONSTANT text := '"/images/' || dirs || '/';
  dest  CONSTANT text := '/api/images/s3/photos/\1/';
  r     record;
  n     bigint;
  total bigint := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.table_name IN ('operator_tours', 'partners', 'transfer_charter_prices', 'transfer_fleet_vehicles',
                            'assets', 'accommodation_assets', 'accommodations', 'car_rental_offers')
       AND c.is_generated = 'NEVER'
       AND (c.data_type IN ('text', 'character varying', 'jsonb')
            OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
     ORDER BY c.table_name, c.ordinal_position
  LOOP
    IF r.data_type IN ('text', 'character varying') THEN
      EXECUTE format('UPDATE %I SET %I = regexp_replace(%I, $1, $2) WHERE %I ~ $1',
                     r.table_name, r.column_name, r.column_name, r.column_name)
        USING re, dest;
    ELSIF r.data_type = 'jsonb' THEN
      EXECUTE format('UPDATE %I SET %I = regexp_replace(%I::text, $1, $2, ''g'')::jsonb WHERE %I::text ~ $1',
                     r.table_name, r.column_name, r.column_name, r.column_name)
        USING jre, '"' || dest;
    ELSE
      EXECUTE format(
        'UPDATE %I SET %I = ARRAY(SELECT regexp_replace(u.e, $1, $2) FROM unnest(%I) WITH ORDINALITY AS u(e, i) ORDER BY u.i)'
        || ' WHERE EXISTS (SELECT 1 FROM unnest(%I) AS x(e) WHERE x.e ~ $1)',
        r.table_name, r.column_name, r.column_name, r.column_name)
        USING re, dest;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE '[1406] %.%: строк %', r.table_name, r.column_name, n;
      total := total + n;
    END IF;
  END LOOP;
  RAISE NOTICE '[1406] всего переписано строк-колонок: %', total;
END $$;

-- Rollback: адреса возвращаются обратной заменой
--   regexp_replace(x, '^/api/images/s3/photos/(<папки>)/', '/images/\1/')
-- по тем же таблицам; снимки при этом должны снова лежать в public/images.
