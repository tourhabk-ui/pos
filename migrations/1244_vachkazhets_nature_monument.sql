-- 1244: Вачкажец — памятник природы: режим без разрешения, правила посещения,
--       «как добраться», медведи в профиле, отзыв-выдумка снят, галерея,
--       справочник парков.
-- Created: 2026-10-14
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 14.10, после заповедников (1240, 1241, 1243): «Памятник природы
-- „Вачкажец“ тоже делаем по примерам». Карточка места (c4310d06…) на проде
-- (проба 832, MCP fetch 14.10): тип «гора», описание — справка владельца 03.10
-- по Википедии (1151), а режима охраны, правил, «как добраться» и сути нет;
-- профиль безопасности — шаблон 070 (`type_template`), то есть не говорит
-- ничего. Отзыв Кузьмича пересказывает ту самую версию, которую 1151
-- опровергла источником: «чёрный базальтовый разлом», «цирки с айсбергами в
-- чаше озера».
--
-- Справочник парков (723) пишет: «Памятник природы — посещение требует
-- отдельного разрешения». Это неверно. Постановление губернатора Камчатского
-- края № 93 от 07.11.2018 «Об установлении охранной зоны памятника природы
-- регионального значения „Горный массив Вачкажец“» разрешения не
-- предусматривает: так разъяснило краевое Минприроды 06.08.2019 (Кам 24,
-- проба 828) и повторила Служба по охране животного мира 24.06.2023
-- (KamchatkaMedia, проба 828) — то самое учреждение, которое такие
-- разрешения выдаёт.
--
-- ── Что меняется и откуда ─────────────────────────────────────────────────
--
-- Тип места НЕ меняется: Вачкажец — горный массив, это географический факт
-- (§9), а «памятник природы» — режим охраны. Режим ложится в eco_zone
-- (`nature_monument`, новый род; словари — PlaceEco, access-text,
-- enrich-places), тип «гора» остаётся для карты, поиска и подбора.
--
--   режим и правила — разъяснения Минприроды (2019) и Службы (2023);
--   «как добраться» — Служба (2023): щит на границе охранной зоны, машину
--     оставляют на обочине технологического проезда газопровода или на
--     специальной площадке; что дорога к памятнику — технологический проезд
--     вдоль газопровода, записано 775 по сообщению Газпром трансгаз Томск;
--   суть и год создания — краеведческий справочник kamchatsky-krai.ru
--     (проба 829): памятник объявлен решением облисполкома № 9 от 09.01.1981,
--     комплексный, 4020 га;
--   медведи — тот же справочник: «нередки встречи с камчатским бурым
--     медведем». Лавины и камнепад стоят в паспортах двух маршрутов массива,
--     но в карточку места не перенесены: паспорт описывает маршрут, а
--     извлечение его полей шло моделью — без чтения самого паспорта это
--     не факт о месте (§4.0);
--   высота 1556 м — Википедия и справочник (одно число у обоих).
--
-- Описание (1151, решение владельца) и координата не трогаются.
--
-- Отзыв Кузьмича — пустая строка, а не NULL: агент kuzmich-place-enricher
-- берёт только NULL и написал бы новый пересказ (1159, 1243).
--
-- ── Профиль безопасности ──────────────────────────────────────────────────
--
-- Переводится из шаблона в `manual` только целиком: поля, которые выдумывал
-- шаблон (лимиты, сложность, местность, «гравийка» 0645), обнуляются явно —
-- иначе вместе с медведями они стали бы «фактами». Высота, медпомощь,
-- регистрация в МЧС не шаблонные и не трогаются, кроме пустой высоты.
-- Профиль, уже переписанный человеком (не `type_template`), не трогается.
--
-- ── Фото ─────────────────────────────────────────────────────────────────
--
-- Главный кадр и девять снимков галереи — Алины Гусаковой (1120–1130), их
-- порядок не меняется. Четыре снимка Wikimedia Commons (CC BY-SA 4.0,
-- extmetadata — проба 829) встают в конец, позиции 10–13; залиты и
-- прочитаны обратно до этой миграции (media-to-s3, прогон 5). Занятая
-- позиция — DO NOTHING.
--
-- ПОСЛЕ ВЫКАТА: полевая карта читает статичные пакеты мест (опасности и
-- сложность берутся из профиля) — перезалить map-places-build (upload:true).
--
-- IDEMPOTENT: каждое изменение сужено до прежнего состояния.

BEGIN;

-- ═══ Карточка места ══════════════════════════════════════════════════════

UPDATE places
   SET eco_zone = 'nature_monument',
       eco_permit_required = FALSE,
       eco_permit_url = NULL,
       eco_rules = 'Разрешение на посещение не нужно: положение об охранной зоне памятника (постановление губернатора Камчатского края № 93 от 07.11.2018) его не предусматривает'
                || E'\n'
                || 'Проезд на машинах по охранной зоне запрещён: на её границе в лесу стоит информационный щит, машину оставляют на обочине технологического проезда газопровода или на специальной площадке'
                || E'\n'
                || 'Палаточные лагеря, костровища и стоянки — только в установленных для этого местах'
                || E'\n'
                || 'Транзитные прогулки и переходы вне туристических маршрутов запрещены'
                || E'\n'
                || 'Посадка летательных аппаратов и высадка пассажиров вне отведённых площадок запрещены'
                || E'\n'
                || 'Запрещено всё, что вредит памятнику: нарушать места обитания растений и животных из Красных книг, загрязнять реки и озеро, нарушать правила пожарной безопасности в лесу',
       updated_at = NOW()
 WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND eco_zone IS NULL;

UPDATE places
   SET essence = 'Горный массив на юге Камчатки с ледниковыми цирками, водопадами и озером Тахколоч; '
              || 'памятник природы регионального значения с 1981 года.',
       updated_at = NOW()
 WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND essence IS NULL;

-- «Как добраться» допишет само расстояние от города, маршруты каталога и
-- строку о режиме (lib/places/access-text.ts) — здесь только записанное.
UPDATE places
   SET access_info = 'Разрешение на посещение не нужно. Дорога к массиву идёт технологическим проездом '
                  || 'вдоль газопровода; в лесу на границе охранной зоны памятника стоит информационный '
                  || 'щит — дальше проезд на машинах закрыт, машину оставляют на обочине технологического '
                  || 'проезда или на специальной площадке.',
       updated_at = NOW()
 WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND access_info IS NULL;

UPDATE places
   SET kuzmich_review = '', updated_at = NOW()
 WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND kuzmich_review LIKE '%базальтовый разлом%';

-- Подвал карточки молчал об источнике (sourceName null, проба 832).
UPDATE places
   SET source_name = 'Википедия; Минприроды Камчатского края; kamchatsky-krai.ru',
       source_url = 'https://ru.wikipedia.org/wiki/%D0%92%D0%B0%D1%87%D0%BA%D0%B0%D0%B6%D0%B5%D1%86',
       updated_at = NOW()
 WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND source_name IS NULL AND source_url IS NULL;

-- ═══ Профиль безопасности ════════════════════════════════════════════════

UPDATE location_safety_profile lsp
   SET hazard_types = ARRAY['bears']::text[],
       capacity_per_day = NULL,
       capacity_per_hour = NULL,
       optimal_group_size = NULL,
       difficulty_level = NULL,
       terrain_type = NULL,
       road_type = NULL,
       road_accessibility = NULL,
       altitude_m = COALESCE(lsp.altitude_m, 1556),
       profile_source = 'manual',
       profile_source_at = NOW(),
       updated_at = NOW()
  FROM places p
 WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   AND lsp.agent_route_id = p.ark_id
   AND lsp.profile_source = 'type_template';

-- ═══ Галерея: четыре снимка Commons после снимков Гусаковой ══════════════

WITH shots(position, width, height, caption, author, license, license_url, source_url, s3_key) AS (
  VALUES
    (10, 1600, 1200, 'Гора Вачкажец', 'Michael Haing', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%93%D0%BE%D1%80%D0%B0_%D0%92%D0%B0%D1%87%D0%BA%D0%B0%D0%B6%D0%B5%D1%86.jpg',
     'photos/vachkazhets/gora-vachkazhets-zimoj.jpg'),
    (11, 2000, 843, 'Панорама горного массива г. Вачкажцы', 'NadezhdaKhaustova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9F%D0%B0%D0%BD%D0%BE%D1%80%D0%B0%D0%BC%D0%B0_%D0%B3%D0%BE%D1%80%D0%BD%D0%BE%D0%B3%D0%BE_%D0%BC%D0%B0%D1%81%D1%81%D0%B8%D0%B2%D0%B0_%D0%B3._%D0%92%D0%B0%D1%87%D0%BA%D0%B0%D0%B6%D1%86%D1%8B.jpg',
     'photos/vachkazhets/panorama-massiva.jpg'),
    (12, 1600, 1200, 'Кедровый стланик на фоне горы Вачкажец', 'Michael Haing', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:%D0%9A%D0%B5%D0%B4%D1%80%D0%BE%D0%B2%D1%8B%D0%B9_%D1%81%D1%82%D0%BB%D0%B0%D0%BD%D0%B8%D0%BA_%D0%BD%D0%B0_%D1%84%D0%BE%D0%BD%D0%B5_%D0%B3%D0%BE%D1%80%D1%8B_%D0%92%D0%B0%D1%87%D0%BA%D0%B0%D0%B6%D0%B5%D1%86.jpg',
     'photos/vachkazhets/kedrovyj-stlanik.jpg'),
    (13, 1600, 1200, 'Вачкажец, 2021', 'Natalia Senatorova', 'CC BY-SA 4.0',
     'https://creativecommons.org/licenses/by-sa/4.0',
     'https://commons.wikimedia.org/wiki/File:Vachkazhets_2021_04.jpg',
     'photos/vachkazhets/rododendron.jpg')
)
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key)
SELECT p.ark_id, s.position, NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, s.author, s.license, s.license_url, s.source_url, s.s3_key
  FROM shots s
  JOIN places p ON p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
 WHERE p.ark_id IS NOT NULL
ON CONFLICT (ark_id, position) DO NOTHING;

-- ═══ Справочник парков ═══════════════════════════════════════════════════

UPDATE parks
   SET description = 'Горный массив на юге Камчатки, в 80 км к западу от Петропавловска-Камчатского: '
                  || 'ледниковые цирки, водопады, озеро Тахколоч. Памятник природы регионального значения '
                  || 'с 1981 года. Разрешение на посещение не нужно — его не предусматривает положение '
                  || 'об охранной зоне памятника (постановление губернатора № 93 от 07.11.2018). Проезд '
                  || 'на машинах по охранной зоне запрещён: машину оставляют у информационного щита на её '
                  || 'границе — на обочине технологического проезда газопровода или на специальной площадке.',
       updated_at = NOW()
 WHERE slug = 'vachkazhets'
   AND description LIKE '%посещение требует отдельного разрешения%';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_place record;
  v_profile text;
  v_gallery int;
  v_park text;
BEGIN
  SELECT name, location_type, eco_zone, eco_permit_required, essence IS NOT NULL AS has_essence,
         access_info IS NOT NULL AS has_access, kuzmich_review
    INTO v_place
    FROM places WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe';
  SELECT lsp.profile_source INTO v_profile
    FROM location_safety_profile lsp JOIN places p ON lsp.agent_route_id = p.ark_id
   WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe';
  SELECT count(*) INTO v_gallery
    FROM place_gallery_photos g JOIN places p ON g.ark_id = p.ark_id
   WHERE p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe' AND g.s3_key LIKE 'photos/vachkazhets/%';
  SELECT description INTO v_park FROM parks WHERE slug = 'vachkazhets';

  IF v_place.name IS NULL THEN
    RAISE WARNING '[1244] Вачкажца (c4310d06) нет в places';
  ELSE
    IF v_place.eco_zone IS DISTINCT FROM 'nature_monument' THEN
      RAISE WARNING '[1244] режим Вачкажца не записан: eco_zone %, разрешение % — режим уже кто-то заполнил?',
        v_place.eco_zone, v_place.eco_permit_required;
    END IF;
    IF NOT v_place.has_essence OR NOT v_place.has_access THEN
      RAISE WARNING '[1244] суть (%) или «как добраться» (%) у Вачкажца пусты', v_place.has_essence, v_place.has_access;
    END IF;
    IF v_place.kuzmich_review LIKE '%базальтовый разлом%' THEN
      RAISE WARNING '[1244] отзыв Кузьмича с опровергнутой версией остался';
    END IF;
  END IF;
  IF v_profile IS DISTINCT FROM 'manual' THEN
    RAISE WARNING '[1244] профиль безопасности Вачкажца не переведён: profile_source % (ждали шаблон)', v_profile;
  END IF;
  IF v_gallery < 4 THEN
    RAISE WARNING '[1244] галерея: снимков Commons % из 4 — позиции 10–13 заняты другими?', v_gallery;
  END IF;
  IF v_park IS NULL OR v_park LIKE '%требует отдельного разрешения%' THEN
    RAISE WARNING '[1244] справочник парков: запись vachkazhets не исправлена';
  END IF;
END $$;

COMMIT;

-- Rollback (выдумку и ложное «нужно разрешение» не возвращаем — источники их опровергают):
-- BEGIN;
-- UPDATE places SET eco_zone = NULL, eco_rules = NULL, essence = NULL, access_info = NULL,
--        source_name = NULL, source_url = NULL
--  WHERE id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe';
-- DELETE FROM place_gallery_photos g USING places p
--  WHERE g.ark_id = p.ark_id AND p.id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
--    AND g.s3_key LIKE 'photos/vachkazhets/%';
-- COMMIT;
