-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1038: «Халактырское озеро» — новое место и два снимка владельца.
--
-- ── Почему новое место ────────────────────────────────────────────────────
--
-- Владелец 27.09 прислал три кадра со словами «Халатырское озеро». Записи
-- такого места в справочнике нет: поиск по «Халактыр» на проде (проба 615)
-- нашёл только пляж, визит-центр пляжа и Халактырские скалы — всё это
-- берег океана, за десяток километров от озера. Повесить снимок озера на
-- карточку пляжа — ровно та ошибка «кадр одного объекта под именем другого»,
-- которую 997 разбирала на стеле.
--
-- ── Откуда координата ─────────────────────────────────────────────────────
--
-- Из OpenStreetMap, way 99590352 (проба 616, зеркало overpass.private.coffee):
--
--   name «Халактырское» · natural=water · water=lake
--   центр контура 53.0235704 / 158.7455782
--
-- Озеро — протяжённый объект, и точка здесь — центр контура, а не место
-- съёмки. `coord_source` = 'external': координата взята из внешнего
-- справочника, права утверждать больше, чем «так записано в OSM», у неё нет.
--
-- ── Что на снимках и что из них следует ───────────────────────────────────
--
-- Вулканы на первом кадре опознаны не на глаз, а геометрией: от центра
-- озера Корякский лежит по азимуту около 355°, Авачинский — около 12°,
-- Козельский — около 20°. Расстояния между вершинами на снимке сходятся с
-- этими углами при обычном поле зрения телефона (Корякский отдельно слева,
-- Авачинский и Козельский парой правее).
--
-- Вид птиц в описание НЕ пишется: «лебеди» видно на снимке, а какие именно —
-- по фотографии я не утверждаю. Не пишется и «озеро не замерзает»: снимок —
-- один день, и что на нём открытая вода у кромки льда, ещё не значит, что
-- так всю зиму.
--
-- ── Кадры ─────────────────────────────────────────────────────────────────
--
-- Из трёх присланных взяты два. Второй и третий — один и тот же вид (две
-- птицы, стая уток, сопки за озером) с шагом в секунды; оставлен третий, он
-- чище. Обрезка обоих — 16:9, 1280x720, JPEG q80. На первом кадре внизу слева
-- был человек в синей шапке с телефоном, внизу справа — зелёный край
-- одежды: окно поднято так, что их в кадре нет.
--
-- Герой — первый кадр (лебеди и три вулкана), галерея — позиция 1.
-- Байты увезёт уборщик cron-images-to-s3 (§4.1).
--
-- Зона НЕ заполняется — по той же причине, что в 997: перечня значений в
-- коде нет, наугад значит сочинить (§4.0).
--
-- ПОСЛЕ ВЫКАТА — перезалив пакетов карты (`map-places-build.yml`,
-- upload:true): полевая карта читает статичные пакеты (§4.1).
--
-- Права: снимки прислал владелец платформы, лицензия не ставится.
--
-- IDEMPOTENT

BEGIN;

-- ── 1. Место ──────────────────────────────────────────────────────────────
-- Не заводится, если живое озеро с таким именем уже появилось другим путём:
-- второй экземпляр был бы дублем, а не местом.
INSERT INTO places (id, name, ark_id, lat, lng, location_type,
                    is_visible, description, coord_source, coord_source_at,
                    source_name, source_url, created_at, updated_at)
SELECT '378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e',
       'Халактырское озеро',
       'fc61e9c7-5cc6-4b8a-9a45-e96a36c5cdbe',
       53.0235704, 158.7455782,
       'lake',
       TRUE,
       'Озеро на восточной окраине Петропавловска-Камчатского, у Халактырского шоссе, рядом с аэропортом Халактырка. С берега на север видны Корякский, Авачинский и Козельский вулканы. На снимках владельца платформы, сделанных, когда вокруг лежал снег, — открытая вода у кромки льда, лебеди и стаи уток. Халактырский пляж на океане — другое место, в десятке километров к востоку.',
       'external', NOW(),
       'OpenStreetMap',
       'https://www.openstreetmap.org/way/99590352',
       NOW(), NOW()
 WHERE NOT EXISTS (
         SELECT 1 FROM places q
          WHERE q.id::text <> '378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e'
            AND q.merged_into_id IS NULL
            AND q.is_visible
            AND q.location_type = 'lake'
            AND q.name ILIKE '%Халактырск%'
       )
ON CONFLICT (id) DO NOTHING;

-- ── 2. Герой ──────────────────────────────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: лебеди на Халактырском озере, вид на вулканы (миграция 1038)',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/ceab1971753d0773bb0faf53f64df505ad287a079befd41be82cd307ce1e959d.jpg'
  FROM places p
 WHERE p.id::text = '378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload')
    OR ai_route_images.prompt = EXCLUDED.prompt;

-- ── 3. Галерея, позиция 1 ─────────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       1,
       NULL::bytea,
       'image/jpeg',
       1280,
       720,
       'Лебеди и утки у кромки льда на Халактырском озере',
       'владелец платформы',
       'migrations/photos/fb9a17aafbd6d840a9f7d633c0170d9bdd7242450afcaa07fa70c04bb89b1430.jpg'
  FROM places p
 WHERE p.id::text = '378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e'
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (ark_id, position) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       caption    = EXCLUDED.caption,
       author     = EXCLUDED.author,
       s3_url     = NULL,
       created_at = NOW()
 WHERE place_gallery_photos.caption = EXCLUDED.caption;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_ark    uuid;
  v_author text;
  v_cap    text;
BEGIN
  SELECT ark_id INTO v_ark FROM places
   WHERE id::text = '378b4fc8-1c95-4b0d-ac4d-6ebdddb26e2e' AND is_visible;

  IF v_ark IS NULL THEN
    RAISE WARNING '[1038] «Халактырское озеро» не заведено (живое озеро с этим именем уже есть?) — снимки не легли';
    RETURN;
  END IF;

  SELECT author INTO v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_author IS DISTINCT FROM 'владелец платформы' THEN
    RAISE WARNING '[1038] герой Халактырского озера НЕ встал: там %', COALESCE('автор «' || v_author || '»', 'строки снимка нет');
  END IF;

  SELECT caption INTO v_cap FROM place_gallery_photos WHERE ark_id = v_ark AND position = 1;
  IF v_cap IS DISTINCT FROM 'Лебеди и утки у кромки льда на Халактырском озере' THEN
    RAISE WARNING '[1038] галерея Халактырского озера: позиция 1 — %, наш кадр не лёг', COALESCE(v_cap, 'пусто');
  END IF;
END $$;

COMMIT;
