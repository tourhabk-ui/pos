-- 1344: тур называет своё главное место — 51 связь по сверке названий
--
-- Основание — слово владельца 29.10 «1в 2б 3 да» на вопрос «на одну локацию
-- несколько предложений». Карточка места показывает все туры к месту,
-- сгруппированные по компаниям (lib/places/place-tours), а карточка тура —
-- строку «к этому месту есть ещё N предложений». Обе стоят на связи
-- operator_tours.main_place_id (1286). На проде она была почти пуста: 1286
-- связала только туры, чья координата совпала с координатой места до
-- последнего знака (3 тура «Местечка»), а туры 1176, 1338 и 1339 миграциями
-- не связаны вовсе — к Горелому, Дачным или Мысу Маячному «Туры сюда» не
-- показывали ни одного тура, хотя их у разных компаний по нескольку.
--
-- ── Правило отбора ─────────────────────────────────────────────────────────
-- Связь ставится, когда тур едет к ОДНОМУ месту. Признак — одна из двух улик:
--   (а) в location_name или в названии тура названо ровно одно живое место
--       справочника, и его имя совпадает с places.name дословно;
--   (б) координата тура — округление до 4–5 знаков координаты этого места:
--       след копирования из MCP get_place_info (toFixed(5),
--       lib/kuzmich/place-info-tool), тот же принцип «улики происхождения»,
--       что в 1286.
-- Тур, у которого в названии два места и более (облёт нескольких вулканов,
-- «А + Б», многодневные по районам), не связывается. Исключение одно: пара
-- «каньон Опасный + Дачные», где автор 1338 сам выбрал Дачные координатой и
-- location_name; ради одного правила для одного продукта тот же выбор
-- применён к такой же паре «Лагуны».
-- По близости координат и по похожести имён связь НЕ выводится (§4.1, §14):
-- «Авачинский» — и вулкан, и перевал, и бухта. Каждая пара ниже сверена
-- глазами 29.10: id и имя места — по живому GET /api/places?q=… (только
-- чтение), slug тура — из файла миграции, который его завёл.
--
-- ── Как пишется ────────────────────────────────────────────────────────────
-- main_place_source = 'verified' — новый, третий источник связи («Ведар
-- сверил названия»), рядом с coords_equal (1286) и operator (кабинет);
-- четвёртый — admin (правка администратором, PATCH
-- /api/admin/operator-tours/<id>, например за гида без кабинета).
-- Строка ложится, только если:
--   - продавец тура — партнёр с этим slug (op_slug): 1338 ставит гиду адрес
--     andrey-zaporozhets, только если адрес свободен; на базе с другим
--     адресом гида его строки не лягут, и это назовёт WARNING ниже — честнее,
--     чем связать тур чужого продавца;
--   - место живое (видимо и не слито) и его имя совпадает дословно: место
--     переименовано или скрыто — связи нет, а не связь «наугад»;
--   - тур не удалён и связи у него ещё нет: выбор оператора, администратора
--     и 1286 не перетирается.
-- Id мест сравниваются текстом: places.id на проде TEXT.
--
-- ── Не связано, с причиной ─────────────────────────────────────────────────
-- Местечко: mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy (три вулкана),
--   mestechko-dolina-geyzerov-tolbachik (два района) — у обоих снимается
--   связь 1286 (ниже, п. 3); mestechko-oblet-koryakskiy-avachinskiy (два
--   вулкана и Налычево).
-- Запорожец: zaporozhets-verblyud-plyazh (перевал и пляж).
-- Край Вулканов: volcanoesland-kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha,
--   volcanoesland-oblet-klyuchevskoy-gruppy-dolina-geyzerov,
--   volcanoesland-splav-bystraya-gorelyy-avachinskiy,
--   volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo (несколько мест).
-- Лагуна: lagexp-mys-mayachnyj-khalaktyrskij-plyazh,
--   lagexp-siti-tur-tuda-gde-vstaet-solntse, оба
--   lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval*,
--   lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya,
--   lagexp-obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki
--   (несколько мест); lagexp-konnaya-progulka («долина реки Авача» — такого
--   места в справочнике нет); lagexp-chasovaya-progulka (маршрут «каждый раз
--   разный»); lagexp-pitomnik-ezdovykh-sobak-snezhnye-psy, lagexp-dukh-kamchatki,
--   lagexp-pogruzhenie-v-kulturu-severa, lagexp-okhotskoe-more (места в
--   справочнике нет); многодневные lagexp-kamchatka-na-maksimum-osennij-marshrut,
--   lagexp-novyj-god-na-kamchatke, lagexp-kamchatka-termalnyj-marshrut,
--   lagexp-novogodnie-vulkany-kamchatki-laguna-4,
--   lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki.
-- «Камчатская рыбалка» (1106, 10 туров): база на реке Камчатке, места в
--   справочнике нет.
-- Рафтинг «Камчатка Рафтинг» и «Семейный Рафтинг» (060, 800, 955): река
--   Быстрая, места в справочнике нет.
--
-- ── Спорное, названное владельцу ───────────────────────────────────────────
-- Толбачик разделён на два места справочника: туры «Местечка» (координата и
-- location_name) — к «Северному прорыву», Запорожец и Край Вулканов — к
-- «Вулкану Плоский Толбачик». «Долина гейзеров и кальдера Узон» Края Вулканов
-- — к Долине гейзеров, как тот же продукт «Местечка». Озеро Толмачёва — к
-- месту «Озеро Толмачева и озеро Маар»: тождество места бесспорно,
-- координата места по шапке 1217 не подтверждена. Любую связь оператор
-- меняет в кабинете (поле «Главное место тура»): источник станет operator.
--
-- Идемпотентна, без BEGIN/COMMIT (транзакцию даёт раннер миграций): CHECK
-- меняется по его определению, связи — только в пустое поле, снятие — только
-- автоматической связи 1286. Повтор ничего не меняет.
--
-- Сторож: tests/unit/tour-main-place-in-migrations.test.ts (каждая строка
-- несёт причину, место и тур, которые заведены миграциями; новые туры в
-- миграциях называют место или причину, почему его нет), на данных —
-- tests/integration/public-tour-gate.pg.test.ts.

-- 1. Источник связи: четыре значения вместо двух.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'operator_tours'::regclass
     AND conname  = 'operator_tours_main_place_source_check';
  IF v_def IS NULL OR position('verified' IN v_def) = 0 THEN
    ALTER TABLE operator_tours DROP CONSTRAINT IF EXISTS operator_tours_main_place_source_check;
    ALTER TABLE operator_tours
      ADD CONSTRAINT operator_tours_main_place_source_check
      CHECK (main_place_source IS NULL OR main_place_source IN ('coords_equal', 'operator', 'verified', 'admin'));
  END IF;
END $$;

-- 2. Связи, сверенные по названиям.
WITH wanted(op_slug, tour_slug, place_id, place_name, reason) AS (
  VALUES
    -- Местечко Камчатка (1217)
    ('mestechko', 'mestechko-vulkan-gorelyy', '2886ce3b-0753-41fb-bacc-f80e3f75d1aa', 'Вулкан Горелый', 'location_name = имя места; координата 52.5588/158.0369 — округление места'),
    ('mestechko', 'mestechko-ozero-tolmachevo', '2512ca75-547c-4348-a219-86c7e6937940', 'Озеро Толмачева и озеро Маар', 'тур — озеро Толмачёва и маар «Медвежья чаша»; одно место справочника'),
    ('mestechko', 'mestechko-halaktyrskiy-plyazh', '49a1d46a-704b-4307-bb6a-fea5988ec4f8', 'Халактырский пляж', 'имя дословно; координата 52.99476/158.85724'),
    ('mestechko', 'mestechko-tolbachik-standard', '84a281c7-c690-4732-82e5-335c6d90c04d', 'Северный прорыв', 'координата тура 55.68883/160.24505 — округление «Северного прорыва»; location_name «Вулкан Толбачик, Северный прорыв»'),
    ('mestechko', 'mestechko-avachinskiy-pereval', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'имя дословно; координата 53.28/158.77139'),
    ('mestechko', 'mestechko-mys-mayachnyy', '3268583a-05e0-4f59-8d2c-a87a69be14a6', 'Мыс Маячный', 'имя дословно; координата 52.88787/158.70902'),
    ('mestechko', 'mestechko-vachkazhets', 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe', 'Вачкажец', 'координата 53.08127/157.93126 — округление места «Вачкажец»'),
    ('mestechko', 'mestechko-dachnye-istochniki', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'уже связан 1286 (coords_equal); строка — для новой базы'),
    ('mestechko', 'mestechko-kurilskoe-ozero', '630819da-48d1-4bb8-99c9-3b190d6ae26c', 'Курильское озеро', 'уже связан 1286; для новой базы'),
    ('mestechko', 'mestechko-dolina-geyzerov', '796c18b3-e199-4ac6-bbd6-de50d560ff40', 'Долина гейзеров', 'уже связан 1286; для новой базы'),
    ('mestechko', 'mestechko-vertolet-tolbachik', '84a281c7-c690-4732-82e5-335c6d90c04d', 'Северный прорыв', 'та же координата и location_name, что у №4'),
    ('mestechko', 'mestechko-ostrov-starichkov', '4dd86a74-d010-4ff4-81ad-23af3ba966a5', 'Остров Старичков', 'название тура; координата 52.77788/158.61846'),
    ('mestechko', 'mestechko-buhta-russkaya', 'af84b5bb-39eb-4b3e-883d-8aa50641077a', 'Бухта Русская', 'имя дословно; координата 52.42352/158.45958'),
    ('mestechko', 'mestechko-snegohod-avachinskiy-pereval', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'как №5'),
    ('mestechko', 'mestechko-snegohod-mys-mayachnyy', '3268583a-05e0-4f59-8d2c-a87a69be14a6', 'Мыс Маячный', 'как №6'),
    -- Гид Андрей Запорожец (1338)
    ('andrey-zaporozhets', 'zaporozhets-vulkan-gorelyy', '2886ce3b-0753-41fb-bacc-f80e3f75d1aa', 'Вулкан Горелый', 'location_name = имя места; координата 52.5588/158.03691'),
    ('andrey-zaporozhets', 'zaporozhets-kanyon-opasnyy-dachnye', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'автор 1338 выбрал Дачные в location_name и координате 52.53/158.192'),
    ('andrey-zaporozhets', 'zaporozhets-tolbachik-4-dnya', 'f7b849df-456d-449c-9416-39683e27b472', 'Вулкан Плоский Толбачик', 'location_name дословно; координата 55.82909/160.38891'),
    ('andrey-zaporozhets', 'zaporozhets-kurilskoe-ozero-3-dnya', '630819da-48d1-4bb8-99c9-3b190d6ae26c', 'Курильское озеро', 'имя и координата 51.455/157.0983'),
    ('andrey-zaporozhets', 'zaporozhets-kurilskoe-ozero-4-dnya', '630819da-48d1-4bb8-99c9-3b190d6ae26c', 'Курильское озеро', 'как №19'),
    ('andrey-zaporozhets', 'zaporozhets-dachnye-spokoynyy', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'location_name дословно; Спокойный — по пути (как у №8)'),
    ('andrey-zaporozhets', 'zaporozhets-vachkazhets-ozerki', 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe', 'Вачкажец', 'цель тура — массив Вачкажец'),
    ('andrey-zaporozhets', 'zaporozhets-avachinskiy-pereval-verblyud', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'location_name дословно; Верблюд стоит на перевале'),
    ('andrey-zaporozhets', 'zaporozhets-avacha-voskhozhdenie', '3a98a68d-76c8-4835-8d6d-24f7dd867cb8', 'Вулкан Авачинский', 'восхождение на этот вулкан'),
    ('andrey-zaporozhets', 'zaporozhets-tolmachevo', '2512ca75-547c-4348-a219-86c7e6937940', 'Озеро Толмачева и озеро Маар', 'как №2'),
    ('andrey-zaporozhets', 'zaporozhets-ganalskie-vostryaki', 'b3ee62b9-e760-4fda-9254-8f8ddbd9c33a', 'Ганальские востряки', 'название тура = имя места'),
    ('andrey-zaporozhets', 'zaporozhets-bukhta-russkaya', 'af84b5bb-39eb-4b3e-883d-8aa50641077a', 'Бухта Русская', 'location_name дословно'),
    -- Край Вулканов (1176)
    ('volcanoesland', 'volcanoesland-ploskiy-tolbachik', 'f7b849df-456d-449c-9416-39683e27b472', 'Вулкан Плоский Толбачик', 'название тура = имя места (координата «приблизительно» — не улика)'),
    ('volcanoesland', 'volcanoesland-treking-podnozhie-klyuchevskoy', '54b106de-d81a-42af-9a41-32ee49604309', 'Вулкан Ключевская сопка', 'одна цель в названии и location_name'),
    ('volcanoesland', 'volcanoesland-treking-vokrug-ploskogo-tolbachika', 'f7b849df-456d-449c-9416-39683e27b472', 'Вулкан Плоский Толбачик', 'трек вокруг одного вулкана; location_name дословно'),
    ('volcanoesland', 'volcanoesland-voskhozhdenie-klyuchevskaya-sopka', '54b106de-d81a-42af-9a41-32ee49604309', 'Вулкан Ключевская сопка', 'восхождение на этот вулкан'),
    ('volcanoesland', 'volcanoesland-kruiz-komandorskie-ostrova', 'a8f3d201-5c9e-4b7a-8d63-2f1e0c4b6a35', 'Командорские острова', 'одна цель; место справочника — нацпарк «Командорские острова»'),
    ('volcanoesland', 'volcanoesland-dolina-geyzerov-kaldera-uzon', '796c18b3-e199-4ac6-bbd6-de50d560ff40', 'Долина гейзеров', 'тот же вертолётный продукт, что тур Местечка №10 (Долина + Узон); одно правило для одного продукта'),
    ('volcanoesland', 'volcanoesland-avtotur-kurilskoe-ozero', '630819da-48d1-4bb8-99c9-3b190d6ae26c', 'Курильское озеро', 'одна цель в названии; Паужетка — база ночёвки'),
    -- Лагуна Экспедиция (1339)
    ('laguna-expedition', 'lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki', '284c862f-a339-409d-988a-da4107324b60', 'Малкинские горячие источники', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-na-kraj-sveta-mys-mayachnyj', '3268583a-05e0-4f59-8d2c-a87a69be14a6', 'Мыс Маячный', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-k-gamulam-na-vilyuchinskij-pereval', '8bad8fe6-c7ec-4403-b956-948706649ca8', 'Вилючинский перевал', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-karymshinskie-termalnye-istochniki', '70f73765-2f2e-40de-846f-62cb6b02252f', 'Карымшинские источники', 'location_name «Карымшинские горячие источники» = это место'),
    ('laguna-expedition', 'lagexp-pervyj-rassvet', '49a1d46a-704b-4307-bb6a-fea5988ec4f8', 'Халактырский пляж', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-mys-mayachnyj', '3268583a-05e0-4f59-8d2c-a87a69be14a6', 'Мыс Маячный', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-k-gamulam-na-vilyuchinskij-pereval-na-vnedorozhnike-tank-300', '8bad8fe6-c7ec-4403-b956-948706649ca8', 'Вилючинский перевал', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-khalaktyrskij-plyazh', '49a1d46a-704b-4307-bb6a-fea5988ec4f8', 'Халактырский пляж', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-v-gosti-k-evrazhkam-na-avachinskij-pereval', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-kanon-opasnyj', '15941908-e492-421a-89b4-766e8b00991c', 'Каньон Опасный', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-krabovoe-safari-v-avachinskoj-bukhte', 'a34d8fa0-e25d-402d-80ce-24404bf7511f', 'Авачинская бухта', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-zelenovskie-ozerki', 'f31f3774-65d4-47b7-a03e-4e3d4a575100', 'Зеленовские озерки', 'имя дословно'),
    ('laguna-expedition', 'lagexp-dva-vulkana-avachinskij-pereval', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'location_name дословно'),
    ('laguna-expedition', 'lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck', '2bf92082-0daf-4770-8031-a51c0f355be8', 'Дачные горячие источники', 'та же пара, что №17 (выбор автора 1338)'),
    ('laguna-expedition', 'lagexp-k-domashnim-vulkanam-na-vezdekhode-sever-truck', '3dd2ceaf-1351-4625-9171-711eb8b1a455', 'Авачинский перевал', 'location_name «Авачинский перевал» — место назначения')
)
UPDATE operator_tours t
   SET main_place_id = w.place_id,
       main_place_source = 'verified',
       updated_at = NOW()
  FROM wanted w
  JOIN partners pa ON pa.slug = w.op_slug
  JOIN places pl ON pl.id::text = w.place_id::text
                AND pl.name = w.place_name
                AND pl.is_visible = TRUE
                AND pl.merged_into_id IS NULL
 WHERE t.slug = w.tour_slug
   AND t.operator_id::text = pa.id::text
   AND t.deleted_at IS NULL
   -- Только в пустое поле: выбор оператора, администратора и связь 1286 не
   -- перетираются, а повтор миграции ничего не меняет.
   AND t.main_place_id IS NULL;

-- 3. Ложные связи у туров на несколько мест. Снимается ТОЛЬКО то, что
-- поставил автомат 1286 (coords_equal), — связь, выбранную человеком, это не
-- трогает. Облёт: координата тура равна координате вулкана Вилючинский
-- (52.705/158.282), и 1286 могла связать облёт трёх вулканов с одним из них.
-- «Долина гейзеров и вулкан Толбачик» — два района.
UPDATE operator_tours
   SET main_place_id = NULL,
       main_place_source = NULL,
       updated_at = NOW()
 WHERE slug IN ('mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy', 'mestechko-dolina-geyzerov-tolbachik')
   AND main_place_source = 'coords_equal';

-- 4. Итог словами: сколько из 51 связано. Меньше — не молчание, а WARNING с
-- тем, где искать (перепись GET /api/cron/tour-tracks-census, блок place_link).
DO $$
DECLARE
  v_linked int;
BEGIN
  SELECT COUNT(*) INTO v_linked
    FROM operator_tours
   WHERE slug IN (
      'mestechko-vulkan-gorelyy',
      'mestechko-ozero-tolmachevo',
      'mestechko-halaktyrskiy-plyazh',
      'mestechko-tolbachik-standard',
      'mestechko-avachinskiy-pereval',
      'mestechko-mys-mayachnyy',
      'mestechko-vachkazhets',
      'mestechko-dachnye-istochniki',
      'mestechko-kurilskoe-ozero',
      'mestechko-dolina-geyzerov',
      'mestechko-vertolet-tolbachik',
      'mestechko-ostrov-starichkov',
      'mestechko-buhta-russkaya',
      'mestechko-snegohod-avachinskiy-pereval',
      'mestechko-snegohod-mys-mayachnyy',
      'zaporozhets-vulkan-gorelyy',
      'zaporozhets-kanyon-opasnyy-dachnye',
      'zaporozhets-tolbachik-4-dnya',
      'zaporozhets-kurilskoe-ozero-3-dnya',
      'zaporozhets-kurilskoe-ozero-4-dnya',
      'zaporozhets-dachnye-spokoynyy',
      'zaporozhets-vachkazhets-ozerki',
      'zaporozhets-avachinskiy-pereval-verblyud',
      'zaporozhets-avacha-voskhozhdenie',
      'zaporozhets-tolmachevo',
      'zaporozhets-ganalskie-vostryaki',
      'zaporozhets-bukhta-russkaya',
      'volcanoesland-ploskiy-tolbachik',
      'volcanoesland-treking-podnozhie-klyuchevskoy',
      'volcanoesland-treking-vokrug-ploskogo-tolbachika',
      'volcanoesland-voskhozhdenie-klyuchevskaya-sopka',
      'volcanoesland-kruiz-komandorskie-ostrova',
      'volcanoesland-dolina-geyzerov-kaldera-uzon',
      'volcanoesland-avtotur-kurilskoe-ozero',
      'lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki',
      'lagexp-na-kraj-sveta-mys-mayachnyj',
      'lagexp-k-gamulam-na-vilyuchinskij-pereval',
      'lagexp-karymshinskie-termalnye-istochniki',
      'lagexp-pervyj-rassvet',
      'lagexp-mys-mayachnyj',
      'lagexp-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck',
      'lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300',
      'lagexp-k-gamulam-na-vilyuchinskij-pereval-na-vnedorozhnike-tank-300',
      'lagexp-khalaktyrskij-plyazh',
      'lagexp-v-gosti-k-evrazhkam-na-avachinskij-pereval',
      'lagexp-kanon-opasnyj',
      'lagexp-krabovoe-safari-v-avachinskoj-bukhte',
      'lagexp-zelenovskie-ozerki',
      'lagexp-dva-vulkana-avachinskij-pereval',
      'lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck',
      'lagexp-k-domashnim-vulkanam-na-vezdekhode-sever-truck'
   )
     AND main_place_source IN ('verified', 'coords_equal', 'operator', 'admin');
  IF v_linked < 51 THEN
    RAISE WARNING '[1344] связано % из 51 (не найдено: тур или место переименованы/скрыты, тур удалён или у гида другой адрес — сверить перепись tour-tracks-census)', v_linked;
  ELSE
    RAISE NOTICE '[1344] связано % из 51', v_linked;
  END IF;
END $$;

COMMENT ON COLUMN operator_tours.main_place_source IS
  'Откуда связь с главным местом: coords_equal — миграция 1286 по точному равенству координат; operator — выбрано оператором в кабинете; verified — миграция по сверке названий тура и места (1344); admin — поставлено администратором платформы.';

-- Rollback:
-- UPDATE operator_tours SET main_place_id = NULL, main_place_source = NULL WHERE main_place_source = 'verified';
-- UPDATE operator_tours SET main_place_source = 'operator' WHERE main_place_source = 'admin';
-- ALTER TABLE operator_tours DROP CONSTRAINT IF EXISTS operator_tours_main_place_source_check;
-- ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_main_place_source_check
--   CHECK (main_place_source IS NULL OR main_place_source IN ('coords_equal', 'operator'));
-- (связи 1286, снятые п. 3, откат не возвращает: какое из мест было выбрано
-- автоматом, база не хранит — их вернёт повтор 1286 на данных.)
