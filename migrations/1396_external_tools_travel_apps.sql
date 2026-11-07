-- Migration 1396: каталог сторонних сервисов — пять приложений в дорогу вместо 48 посеянных
-- Created: 2026-11-07
--
-- Решение владельца 07.11: «карт-бланш» на средний путь — оставить то, что
-- реально нужно в поездке, остальное убрать. Владелец считал этот каталог
-- инструментами Ведара; это список чужих приложений, который советует Кузьмич
-- и показывает страница /ai-tools.
--
-- Что было не так с посевом 666:
--   - метка source='taaft' стояла по умолчанию колонки: из каталога TAAFT
--     (theresanaiforthat.com) не пришло ни одной записи, все 48 вписаны рукой;
--   - 668 отметила все 48 «проверенными» скопом — по той же метке, а не по
--     проверке; Кузьмич и /ai-tools показывают только «проверенные», то есть всё;
--   - около двадцати записей — инструменты для бизнеса и сайтов, а не для
--     туриста (Ahrefs, Similarweb, Metabase, Copy.ai, Notion AI, Grammarly,
--     ElevenLabs, Suno, remove.bg, TinyPNG и т.д.);
--   - часть делает сам Ведар: погода, вулканы, землетрясения, высоты, GPX,
--     ссылка в Organic Maps на карточке места;
--   - две записи опасны в поле: чужой SOS-сервис (sos-share), которого никто
--     не проверял, и «лавинный прогноз» avalanche.org — сайт США, Камчатки там
--     нет. SOS, обстановка, вулканы и погода — только инструменты Ведара и 112;
--   - сервисы Anthropic и OpenAI закрыты для России (гео-блок их API с прода
--     записан в §8 CLAUDE.md), а в списке стояли Claude, Whisper и OpenAI Vision.
--
-- Остаются пять — то, чего у Ведара нет: офлайн-карты (Organic Maps), треки
-- туристов (Wikiloc), вершины и отчёты восходителей (Peakbagger), определение
-- растений (Pl@ntNet) и животных (iNaturalist) по фото. Описания переписаны
-- 07.11 по сайтам и магазинам приложений самих сервисов: без чисел и
-- превосходных степеней, которые нечем подтвердить. У 666 было «35 000 видов»,
-- «Крупнейшая база» и «Незаменим для определения ядовитых и лекарственных
-- растений» — последнее ещё и опасно: определитель по фото подсказывает вид,
-- а не съедобность и не безопасность.
--
-- Удаляются только строки посева 666 (source='taaft', slug из посева):
-- добавленное администратором не трогается. Вернуть запись — строкой 666.
-- Рейтинги не возвращаются: их не было (1341).

BEGIN;

DELETE FROM external_tools
 WHERE source = 'taaft'
   AND slug IN (
    'avalanche-forecast', 'windy', 'sos-share', 'emergency-response-africa',
    'magma-volcano', 'gpx-studio', 'brouter', 'caltopo',
    'overpass-turbo', 'open-topo-data', 'komoot', 'google-lens',
    'remove-bg', 'tinypng', 'upscayl', 'birda',
    'cloudinary', 'deepl', 'otter-ai', 'whisper-openai',
    'claude-ai', 'grammarly', 'quillbot', 'copy-ai',
    'notion-ai', 'elevenlabs', 'murf-ai', 'adobe-podcast',
    'descript', 'suno', 'datawrapper', 'flourish',
    'similarweb', 'ahrefs-free', 'metabase', 'openai-vision-api',
    'alltrails', 'mountain-forecast', 'gaia-gps', 'strava',
    'ioverland', 'polarsteps', 'nomadlist'
   );

-- Пять оставшихся: разделы «Карты и треки» (maps) и «Растения и животные по
-- фото» (nature). Источник каждого описания — сайт или магазин приложений
-- самого сервиса, 07.11.
UPDATE external_tools AS et
   SET name          = v.name,
       description   = v.description,
       url           = v.url,
       category      = v.category,
       tags          = v.tags,
       is_free       = TRUE,
       api_available = FALSE,
       rating        = NULL,
       verified      = TRUE,
       updated_at    = NOW()
  FROM (VALUES
    ('organic-maps', 'Organic Maps',
     'Офлайн-карты и навигация на основе OpenStreetMap: пешком, на велосипеде, на машине. Работает без интернета; бесплатно, без рекламы.',
     'https://organicmaps.app', 'maps', ARRAY['офлайн','карты','навигация','osm']),
    ('wikiloc', 'Wikiloc',
     'GPS-треки, которые выкладывают сами туристы: поиск маршрутов рядом с точкой на карте. Основное бесплатно; навигация по треку с подсказками — по подписке Premium.',
     'https://www.wikiloc.com', 'maps', ARRAY['треки','gpx','маршруты','туристы']),
    ('peakbagger', 'Peakbagger',
     'База вершин мира: высоты, отчёты о восхождениях и GPX-треки от самих восходителей. Бесплатно.',
     'https://www.peakbagger.com', 'maps', ARRAY['вершины','восхождения','вулканы','gpx']),
    ('plantnet', 'Pl@ntNet',
     'Определение растения по фото листа, цветка, плода или коры: приложение предлагает похожие виды. Бесплатное, его делает научный консорциум (Cirad, INRAE, Inria, IRD).',
     'https://identify.plantnet.org', 'nature', ARRAY['растения','фото','определение']),
    ('inaturalist', 'iNaturalist',
     'Определение животных, растений и грибов по фото: приложение предлагает похожие виды, наблюдения проверяют другие натуралисты. Бесплатное, некоммерческое.',
     'https://www.inaturalist.org', 'nature', ARRAY['животные','растения','грибы','птицы','фото','определение'])
  ) AS v(slug, name, description, url, category, tags)
 WHERE et.slug = v.slug;

COMMIT;

-- Rollback: удалённые строки — посев 666 (те же slug, source по умолчанию),
-- прежние тексты пяти оставшихся — там же. Рейтинги из 666 не возвращать:
-- оценок не было (1341).
