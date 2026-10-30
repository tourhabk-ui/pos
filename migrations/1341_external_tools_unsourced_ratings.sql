-- Migration 1341: снимаются выдуманные «рейтинги» каталога внешних инструментов и цифры iNaturalist без источника
-- Created: 2026-10-29
--
-- Разбор бесплатных API 29.10 (карт-бланш владельца) дошёл до каталога
-- /ai-tools. Миграция 666 положила 48 инструментам «рейтинг» от 4.2 до 4.9.
-- Страница рисует его жёлтой звездой с числом — так выглядит оценка людей.
-- Но оценок не было ни одной: числа сочинены при посеве, источника нет ни
-- у одного. Тот же случай, что «rating: 4.5 у перевозчика, которого никто не
-- оценивал» (§4.0): нет оценок — нет и числа. NULL звезду прячет
-- (`Stars` в _AIToolsClient), сортировка «по рейтингу» уходит в NULLS LAST.
--
-- Снимается только посеянное: пара (slug, rating) совпадает с 666 слово в
-- слово. Число, которое потом поставил администратор (форма /api/admin/taaft),
-- — уже его решение, и миграция его не трогает.
--
-- Описание iNaturalist несло «500 млн наблюдений от 7 млн натуралистов» —
-- цифры без источника и без даты, которые к тому же устаревают сами. Замена —
-- только если текст тот же, что положила 666.
--
-- Идемпотентна: повтор не найдёт посеянных пар.

BEGIN;

UPDATE external_tools et
   SET rating = NULL,
       updated_at = NOW()
  FROM (VALUES
    ('avalanche-forecast', 4.5), ('windy', 4.8), ('sos-share', 4.2), ('emergency-response-africa', 4.6),
    ('magma-volcano', 4.7), ('gpx-studio', 4.6), ('brouter', 4.3), ('caltopo', 4.5),
    ('overpass-turbo', 4.4), ('open-topo-data', 4.3), ('komoot', 4.7), ('wikiloc', 4.4),
    ('organic-maps', 4.8), ('plantnet', 4.6), ('inaturalist', 4.8), ('google-lens', 4.7),
    ('remove-bg', 4.5), ('tinypng', 4.6), ('upscayl', 4.4), ('birda', 4.8),
    ('cloudinary', 4.5), ('deepl', 4.9), ('otter-ai', 4.5), ('whisper-openai', 4.7),
    ('claude-ai', 4.9), ('grammarly', 4.6), ('quillbot', 4.4), ('copy-ai', 4.3),
    ('notion-ai', 4.5), ('elevenlabs', 4.8), ('murf-ai', 4.4), ('adobe-podcast', 4.7),
    ('descript', 4.5), ('suno', 4.3), ('datawrapper', 4.7), ('flourish', 4.5),
    ('similarweb', 4.4), ('ahrefs-free', 4.3), ('metabase', 4.5), ('openai-vision-api', 4.6),
    ('alltrails', 4.8), ('peakbagger', 4.4), ('mountain-forecast', 4.6), ('gaia-gps', 4.7),
    ('strava', 4.5), ('ioverland', 4.3), ('polarsteps', 4.5), ('nomadlist', 4.2)
  ) AS seeded(slug, rating)
 WHERE et.slug = seeded.slug
   AND et.rating = seeded.rating::numeric;

UPDATE external_tools
   SET description = 'Определение животных, растений и грибов по фото. Наблюдения публикуют и проверяют сами натуралисты.',
       updated_at = NOW()
 WHERE slug = 'inaturalist'
   AND description = 'Определение животных, растений, грибов по фото. База из 500 млн наблюдений от 7 млн натуралистов.';

COMMIT;

-- Rollback: числа были выдуманы, возвращать их нечем оправдать. Если нужно
-- восстановить вид до миграции — значения в 666.
