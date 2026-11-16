-- Migration 1455: противоречия в карточках туров и мест (#3467)
-- Created: 2026-11-16
--
-- Issue #3467 завела Фло по просьбе владельца 16.11. Нестыковки нашлись при
-- сверке постов VK и в ответе внешнего ИИ по кнопке «Спросите про Ведар у
-- своего ИИ»: ИИ первым делом указывает на них, а это бьёт по доверию к
-- карточкам. Здесь правится только то, что решается без нового факта:
-- противоречие с записанным источником убирается, число, которое повторяет
-- шапку карточки другим способом счёта, уходит из текста. Чего мы не знаем,
-- так и названо (§0, §4.0).
--
-- ── 1. Тур «Зеленовские озерки» (Лагуна Экспедиция, 1339) ─────────────────
--
-- Текст тура — слова оператора с его сайта (1339). Два места в них Ведар
-- публиковать не может:
--   • «термальных источников с радоновой водой» и «бассейны с радоновой
--     водой» — карточка места (1157, по химическому анализу на стендах
--     комплекса, скважины К-5 и К-01) говорит: «радона в составе нет».
--     Утверждать на одной платформе и то и другое — сказать неправду в одном
--     из двух мест. Слово «радоновой» снимается, остальное слово в слово;
--   • «помогает снять усталость и напряжение, улучшить кровообращение,
--     укрепить иммунитет» — медицинское обещание без источника. Критерий
--     issue: публичные тексты без медицинских обещаний. Фраза снимается целиком.
--
-- Куда везут на деле, Ведар не знает. Тур назван по комплексу «Зеленовские
-- озерки», а строка «не входит» — «входные билеты в санатории «Раздолье
-- Камчатки»» с ценой 700 ₽; у многодневного тура того же оператора 700 ₽ —
-- вход именно в «Раздолье», а «Зеленовские озерки» — 400 ₽. Это соседняя
-- база на другой скважине (карточка места). Название тура не меняется:
-- это решение оператора. Строка «не входит» говорит о билетах без имени
-- комплекса, а примечание к цене называет расхождение и отсылает к
-- оператору. Длительность в часах и условия отмены на сайте оператора не
-- записаны (1339) — поля остаются пустыми, это вопрос оператору.
--
-- Та же пара — в программе многодневного «Камчатка: термальный маршрут»
-- (день 3: «источники с радоновой водой», «считается, что она помогает …
-- улучшить кровообращение») и в программе гида Андрея Запорожца «Вачкажец»
-- (1342: «Воды источников — смесь радоновых и сероводородных»). Правятся
-- теми же словами.
--
-- ── 2. Расстояние в тексте места против шапки «по прямой» ──────────────────
--
-- Шапка карточки считает расстояние до Петропавловска по прямой от
-- координат места и пишет «по прямой» словами (lib/places/distance-to-city).
-- Текст источника нёс своё число без способа счёта — у Малкинских «примерно
-- 120 км» (Википедия) при 82 по прямой, у Тимоновских «90 километров» при 94,
-- у Авачинского перевала и экструзии Верблюд «28 километров» (сайт парка)
-- при 31. Дорога ли это, источник не говорит, и подписать «по дороге» было
-- бы догадкой. Поэтому число уходит из текста, сторона света остаётся:
-- расстояние на карточке одно — в шапке, со способом счёта.
--
-- ── 3. Озеро Ажабачье ─────────────────────────────────────────────────────
--
-- Площадь записана двумя числами с источниками (водный реестр 63,9 км², более
-- поздние данные 56,5 км²) — какое верно, Ведар не знает, и оба остаются с
-- подписью. Но «четвёртое по площади» стояло без оговорки, хотя от выбора
-- числа оно зависит. Теперь это слова Википедии с этой оговоркой; суть карточки
-- (essence) ранга больше не утверждает.
--
-- ── Что НЕ правится, и почему ──────────────────────────────────────────────
--   • река Коль (1255): «около 130 км по данным дирекции» и «Википедия
--     называет 122» — два источника названы, причина расхождения (подвижное
--     русло) в том же предложении. Выбрать одно без третьего источника —
--     выдумка;
--   • озеро Толмачёва, 84 и 85 км по прямой — это шапки двух разных мест с
--     разными координатами, а не текст против шапки;
--   • описание зимней рыбалки (1106) — слова партнёра; расхождение с
--     календарём клёва называет сама карточка (FishSeasonCalendar, #3467).
--
-- Журнал происхождения (911): каждая правка описания места — запись
-- 'owner-decision' (issue по просьбе владельца) с фактами и источником.
-- Идемпотентна: каждая правка — replace() по точной фразе и только там, где
-- фраза ещё стоит; повтор ничего не меняет и журнал не дописывает.

BEGIN;

-- ═══ 1. Туры ══════════════════════════════════════════════════════════════

UPDATE operator_tours
   SET description = replace(
         replace(description,
           'термальных источников с радоновой водой, где',
           'термальных источников, где'),
         'Вода в этих источниках богата микроэлементами, помогает снять усталость и напряжение, улучшить кровообращение, укрепить иммунитет и повысить общий тонус организма.' || E'\n',
         ''),
       updated_at = NOW()
 WHERE slug = 'lagexp-zelenovskie-ozerki'
   AND deleted_at IS NULL
   AND (description LIKE '%с радоновой водой%' OR description LIKE '%укрепить иммунитет%');

UPDATE operator_tours
   SET not_included = array_replace(not_included,
         'входные билеты в санатории «Раздолье Камчатки» (бассейны с радоновой водой)',
         'входные билеты в бассейны — оплачиваются на месте'),
       updated_at = NOW()
 WHERE slug = 'lagexp-zelenovskie-ozerki'
   AND deleted_at IS NULL
   AND 'входные билеты в санатории «Раздолье Камчатки» (бассейны с радоновой водой)' = ANY (not_included);

UPDATE operator_tours
   SET price_note = concat_ws(' ', NULLIF(btrim(price_note), ''),
         'Куда именно везут, на сайте оператора сказано по-разному: тур назван по комплексу «Зеленовские озерки», а входные билеты — в «Раздолье Камчатки», соседнюю базу на другой скважине. Комплекс, длительность поездки и условия отмены уточняйте у оператора.'),
       updated_at = NOW()
 WHERE slug = 'lagexp-zelenovskie-ozerki'
   AND deleted_at IS NULL
   AND COALESCE(price_note, '') NOT LIKE '%Куда именно везут%';

UPDATE operator_tours
   SET program = replace(
         replace(program::text,
           'День 3. Зеленовские озерки: источники с радоновой водой',
           'День 3. Зеленовские озерки'),
         'Вода здесь богата микроэлементами: считается, что она помогает снять усталость и напряжение, улучшить кровообращение и повысить общий тонус организма. ',
         '')::jsonb,
       updated_at = NOW()
 WHERE slug = 'lagexp-kamchatka-termalnyj-marshrut'
   AND deleted_at IS NULL
   AND program IS NOT NULL
   AND (program::text LIKE '%с радоновой водой%' OR program::text LIKE '%улучшить кровообращение%');

UPDATE operator_tours
   SET program = replace(program::text,
         ' Воды источников — смесь радоновых и сероводородных.',
         '')::jsonb,
       updated_at = NOW()
 WHERE slug = 'zaporozhets-vachkazhets-ozerki'
   AND deleted_at IS NULL
   AND program IS NOT NULL
   AND program::text LIKE '%смесь радоновых и сероводородных%';

-- ═══ 2. Расстояния: число уходит из текста, шапка остаётся ═══════════════

-- Малкинские горячие источники (1040).
WITH upd AS (
  UPDATE places p
     SET description = replace(description,
           'в долине между горами, примерно в 120 км к северо-западу от Петропавловска-Камчатского.',
           'в долине между горами, к северо-западу от Петропавловска-Камчатского.'),
         updated_at = NOW()
    FROM (SELECT id, LENGTH(description) AS prev_chars FROM places WHERE id::text = '284c862f-a339-409d-988a-da4107324b60') old
   WHERE p.id::text = old.id::text
     AND p.description LIKE '%примерно в 120 км к северо-западу%'
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 1040 (Википедия) без числа «примерно 120 км»: расстояние называет шапка карточки, по прямой от координат места (#3467)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- Тимоновские источники (1257).
WITH upd AS (
  UPDATE places p
     SET description = replace(description,
           'в 90 километрах к северо-северо-западу от Петропавловска-Камчатского',
           'к северо-северо-западу от Петропавловска-Камчатского'),
         access_info = replace(access_info,
           'в 90 километрах к северо-северо-западу от Петропавловска-Камчатского',
           'к северо-северо-западу от Петропавловска-Камчатского'),
         updated_at = NOW()
    FROM (SELECT id, LENGTH(description) AS prev_chars FROM places WHERE id::text = '15bf29b0-9b1b-49c5-be1f-4c8d5d185f4e') old
   WHERE p.id::text = old.id::text
     AND (p.description LIKE '%в 90 километрах к северо-северо-западу%'
          OR p.access_info LIKE '%в 90 километрах к северо-северо-западу%')
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 1257 (Википедия — «Тимоновские источники») без числа «в 90 километрах»: расстояние называет шапка карточки, по прямой от координат места (#3467)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- Авачинский перевал (1253).
WITH upd AS (
  UPDATE places p
     SET description = replace(description,
           'На перевале, в 28 километрах от Петропавловска-Камчатского, стоит экструзия',
           'На перевале стоит экструзия'),
         updated_at = NOW()
    FROM (SELECT id, LENGTH(description) AS prev_chars FROM places WHERE id::text = '3dd2ceaf-1351-4625-9171-711eb8b1a455') old
   WHERE p.id::text = old.id::text
     AND p.description LIKE '%в 28 километрах от Петропавловска-Камчатского%'
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 1253 (сайт парка «Вулканы Камчатки») без числа «в 28 километрах»: расстояние называет шапка карточки, по прямой от координат места (#3467)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- Экструзия Верблюд (1253) — то же число с того же сайта.
WITH upd AS (
  UPDATE places p
     SET description = replace(description,
           'Авачинский и Корякский, в 28 километрах от Петропавловска-Камчатского. Абсолютная',
           'Авачинский и Корякский. Абсолютная'),
         essence = replace(essence,
           'Авачинский и Корякский, в 28 км от Петропавловска-Камчатского; зона',
           'Авачинский и Корякский; зона'),
         updated_at = NOW()
    FROM (SELECT id, LENGTH(description) AS prev_chars FROM places WHERE id::text = '32aa0d20-10d9-4fbb-a1f7-b90f327b7687') old
   WHERE p.id::text = old.id::text
     AND (p.description LIKE '%в 28 километрах от Петропавловска-Камчатского%'
          OR p.essence LIKE '%в 28 км от Петропавловска-Камчатского%')
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 1253 (сайт парка «Вулканы Камчатки») без числа «в 28 километрах»: расстояние называет шапка карточки, по прямой от координат места (#3467)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- ═══ 3. Озеро Ажабачье (1257): ранг — словами источника ══════════════════

WITH upd AS (
  UPDATE places p
     SET description = replace(description,
           'в бассейне реки Камчатки; по площади оно четвёртое среди озёр полуострова.',
           'в бассейне реки Камчатки. Википедия называет его четвёртым по площади среди озёр полуострова; площадь озера записана двумя разными числами (ниже), и по какому из них этот счёт, источник не говорит.'),
         essence = replace(essence,
           'Четвёртое по площади озеро Камчатки, у низовьев реки Камчатки:',
           'Озеро у низовьев реки Камчатки:'),
         updated_at = NOW()
    FROM (SELECT id, LENGTH(description) AS prev_chars FROM places WHERE id::text = '7498601a-86b8-4560-bf58-e6e2e751b7a8') old
   WHERE p.id::text = old.id::text
     AND (p.description LIKE '%по площади оно четвёртое среди озёр полуострова.%'
          OR p.essence LIKE 'Четвёртое по площади озеро Камчатки%')
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 1257 (Википедия — «Ажабачье»): «четвёртое по площади» — слова Википедии с оговоркой о двух записанных площадях, 63,9 и 56,5 км² (#3467)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- ═══ Исход ═══════════════════════════════════════════════════════════════
-- Чего правка не нашла, не выдаётся за «исправлено»: оставшиеся фразы — WARNING.
DO $$
DECLARE
  v_tours int;
  v_places int;
BEGIN
  SELECT count(*) INTO v_tours
    FROM operator_tours
   WHERE deleted_at IS NULL
     AND slug IN ('lagexp-zelenovskie-ozerki', 'lagexp-kamchatka-termalnyj-marshrut', 'zaporozhets-vachkazhets-ozerki')
     AND (COALESCE(description, '') || COALESCE(program::text, '') || COALESCE(array_to_string(not_included, ' '), ''))
         ~ '(радонов|кровообращени|иммунитет)';
  SELECT count(*) INTO v_places
    FROM places
   WHERE id::text IN ('284c862f-a339-409d-988a-da4107324b60', '15bf29b0-9b1b-49c5-be1f-4c8d5d185f4e',
                      '3dd2ceaf-1351-4625-9171-711eb8b1a455', '32aa0d20-10d9-4fbb-a1f7-b90f327b7687')
     AND (COALESCE(description, '') || ' ' || COALESCE(essence, '') || ' ' || COALESCE(access_info, ''))
         ~ '(120 км к северо|в 90 километрах|в 28 (км|километрах) от Петропавловска)';
  IF v_tours > 0 THEN
    RAISE WARNING '[1455] у % тур(ов) осталась фраза о радоне или медицинское обещание — текст отличается от записанного 1339/1342, поправить руками', v_tours;
  END IF;
  IF v_places > 0 THEN
    RAISE WARNING '[1455] у % мест(а) в тексте осталось расстояние без способа счёта — текст отличается от записанного, поправить руками', v_places;
  END IF;
END $$;

COMMIT;
