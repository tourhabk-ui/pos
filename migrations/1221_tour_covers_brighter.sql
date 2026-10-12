-- 1221: Обложки туров витрины — ярче, и без автобуса у вертолётного тура.
--
-- Два слова владельца 12.10, с телефона:
--   «почему облёт вулкана Толбачик вертолёт, а на фото автобус ПАЗ?» —
--     у тура «Вулкан Толбачик (вертолёт)» первым снимком со страницы
--     оператора пришёл стоковый кадр автобуса на зелёной дороге (не Камчатка);
--   «на главной у нас почти все туры с каким-то серым небом, а хочется
--     поярче фоток» — герой карточки на главной, в каталоге и в карточке
--     тура — ПЕРВЫЙ снимок галереи (lib/tours/hero-image), а первым у
--     импортированных туров стоял первый снимок с сайта оператора, каким бы
--     он ни был: серое небо, сумерки, склад с уловом.
--
-- Как выбирали. Все 184 снимка туров витрины (Местечко 1217, Край Вулканов
-- 1177, Камчатская рыбалка 836 и 1106, сплав 813) замерены
-- scripts/photo-vividness.mjs: цветность по Hasler–Süsstrunk и доля серого
-- неба в верхней трети кадра, оценка = цветность − 40·серое небо. Число
-- решало спор «какой ярче»; СЮЖЕТ смотрели глазами по контактным листам
-- (все снимки тура в ряд): обложкой становится самый яркий из тех, что про
-- сам тур. Оценка старой → новой обложки у каждой замены (12.10):
--
--   Местечко Камчатка
--   halaktyrskiy-plyazh   01 сёрфер в серой воде 15.6 → 05 чёрный пляж, синее море 61.3
--   tolbachik-standard    01 закат, белёсое небо   6.7 → 05 конусы с воздуха, синее небо 35.0
--   avachinskiy-pereval   01 Корякский, белое небо 3.9 → 03 Корякский, синее небо 68.3
--   mys-mayachnyy         01 маяк в дымке          9.6 → 04 бухта, скала, синяя вода 64.4
--   dachnye-istochniki    01 вулкан над облаками  33.1 → 02 пар в зелёной долине 41.4
--   oblet-vilyuchinskiy…  01 фумарола, серое небо 16.7 → 02 Вилючинский над красной тундрой 67.8
--   oblet-koryakskiy…     01 вертолёт с группой   56.3 → 03 вершина Корякского с воздуха 67.3
--   vertolet-tolbachik    01 АВТОБУС — снят вовсе; 02 вертолёт на тёмной лаве 11.2 → 04 конусы, синее небо 35.0
--   Край Вулканов
--   kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha
--                         01 Корякский над шоссе  31.6 → 02 Вилючинский с моря 45.8
--   kruiz-komandorskie-ostrova
--                         01 хвост кита, серая вода 22.6 → 04 топорок на синем небе 62.4
--   dolina-geyzerov-kaldera-uzon
--                         01 гейзер в паре, серое −3.3 → 03 долина, синее небо 35.8
--   avtotur-kurilskoe-ozero
--                         01 вахтовка на пароме, серое 3.2 → 05 группа у озера, вулкан 76.7
--   Камчатская рыбалка
--   id 5 (чавыча и нерка) catch-02 рыба на складе 22.3 → catch-05 рыбак на реке 48.5
--                         (catch-05 — из проверенного набора 836, добавляется в галерею)
--
-- Что НЕ менялось, и почему:
--   «Озеро Толмачёва» — второй и последний снимок тура — асфальт моста под
--     синим небом; на обложке тура к озеру он спросит «почему мост?», как
--     автобус спросил «почему ПАЗ». Нужен снимок озера от оператора.
--   «Горный массив Вачкажец» — все пять снимков серые (оценки 30…−18),
--     выбирать не из чего. Тот же ответ.
--   Зимняя рыбалка (36–38), летние 6 и 9 — ярче ПРОВЕРЕННЫХ снимков этого
--     оператора нет: серия 2025-02-10 чужая (836), остальное — те же кадры,
--     что уже стоят обложками у соседних туров.
--   Остальные 20 туров витрины — обложка и так синее небо или сочный кадр.
--
-- Механика. Обложка не переписывает галерею, а переставляется в её начало:
-- `ARRAY[обложка] || array_remove(photos, обложка)`. Перестановка — только
-- если снимок в галерее ЕСТЬ (оператор мог убрать его в кабинете, и назад
-- мы его не вернём) и он ещё не первый. tour_image — зеркало обложки, как
-- ставили 835/836/1217. Идемпотентно. Файл автобуса из репозитория удалён
-- (public/images/mestechko/vertolet-tolbachik-01.*), манифест нарезки — без
-- него.
--
-- Сторож: tests/unit/tour-covers-brighter.test.ts — каждая новая обложка
-- лежит на диске и в манифесте нарезки, форма UPDATE та же, автобуса нет, и
-- оценка новой обложки ВЫШЕ прежней ПО ЗАМЕРУ тем же скриптом, а не по
-- памяти этой шапки.

-- 1. Автобус — вон из галереи вертолётного тура.
UPDATE operator_tours
   SET photos     = array_remove(photos, '/images/mestechko/vertolet-tolbachik-01.jpg'),
       tour_image = CASE WHEN tour_image = '/images/mestechko/vertolet-tolbachik-01.jpg' THEN NULL ELSE tour_image END,
       updated_at = NOW()
 WHERE slug = 'mestechko-vertolet-tolbachik'
   AND deleted_at IS NULL
   AND '/images/mestechko/vertolet-tolbachik-01.jpg' = ANY(photos);

-- 2. Обложка — в начало галереи (только если снимок в ней есть).
UPDATE operator_tours ot
   SET photos     = ARRAY[v.cover]::text[] || array_remove(ot.photos, v.cover),
       tour_image = v.cover,
       updated_at = NOW()
  FROM (VALUES
    ('mestechko-halaktyrskiy-plyazh',                    '/images/mestechko/halaktyrskiy-plyazh-05.jpg'),
    ('mestechko-tolbachik-standard',                     '/images/mestechko/tolbachik-standard-05.jpg'),
    ('mestechko-avachinskiy-pereval',                    '/images/mestechko/avachinskiy-pereval-03.jpg'),
    ('mestechko-mys-mayachnyy',                          '/images/mestechko/mys-mayachnyy-04.jpg'),
    ('mestechko-dachnye-istochniki',                     '/images/mestechko/dachnye-istochniki-02.jpg'),
    ('mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy', '/images/mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-02.jpg'),
    ('mestechko-oblet-koryakskiy-avachinskiy',           '/images/mestechko/oblet-koryakskiy-avachinskiy-03.jpg'),
    ('mestechko-vertolet-tolbachik',                     '/images/mestechko/vertolet-tolbachik-04.jpg'),
    ('volcanoesland-kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha', '/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-02.jpg'),
    ('volcanoesland-kruiz-komandorskie-ostrova',         '/images/volcanoesland/kruiz-komandorskie-ostrova-04.jpg'),
    ('volcanoesland-dolina-geyzerov-kaldera-uzon',       '/images/volcanoesland/dolina-geyzerov-kaldera-uzon-03.jpg'),
    ('volcanoesland-avtotur-kurilskoe-ozero',            '/images/volcanoesland/avtotur-kurilskoe-ozero-05.jpg')
  ) AS v(slug, cover)
 WHERE ot.slug = v.slug
   AND ot.deleted_at IS NULL
   AND v.cover = ANY(ot.photos)
   AND ot.photos[1] IS DISTINCT FROM v.cover;

-- 3. «Летняя рыбалка на чавычу и нерку» (id 5, «Камчатская рыбалка»):
--    обложка со склада → рыбак на реке. Снимок проверен в 836 (стоит в
--    галереях туров 4 и 9), в галерее пятого его не было — добавляется первым.
UPDATE operator_tours ot
   SET photos     = ARRAY['/images/fishingkam/catch-05.jpg']::text[] || array_remove(ot.photos, '/images/fishingkam/catch-05.jpg'),
       tour_image = '/images/fishingkam/catch-05.jpg',
       updated_at = NOW()
 WHERE ot.id = 5
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE 'камчатская рыбалка' LIMIT 1)
   AND ot.photos[1] IS DISTINCT FROM '/images/fishingkam/catch-05.jpg';
