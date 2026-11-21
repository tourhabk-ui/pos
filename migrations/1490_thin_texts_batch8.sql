-- 1490: тексты для тонких страниц, партия 8 (бывший номер 1489 — столкновение с 1489_geyser_valley_facts_3487.sql) (Сыщик 21.11) — 2 места и 2 маршрута.
--
-- Порядок тот же, что у 1480–1488: черновики Сыщика не публикуются как есть,
-- каждый текст переписан по первоисточникам (страницы Камчатского филиала
-- ФБУ «ТФГИ по ДФО», официальный паспорт маршрута «Горный массив Вачкажец» и
-- его страница на Камчатском туристическом портале, «Кам 24» со словами
-- министра природных ресурсов края), скачанным 21.11 независимо от Сыщика.
-- Без цен, телефонов и разметки, названия карточек не меняются.
--
-- Не вошло: сравнения координат карточек с точками источников (лежбище на
-- Моховой, водопад, цирк); длина и время официального маршрута у карточки
-- «Гора Летняя Поперечная» (у карточки свои 6,2 км — числа не смешиваем);
-- высота вершины, длина нитки и точки старта из пользовательского каталога;
-- часы и телефон музея.
--
-- Границы те же: пишется только туда, где описания нет или оно короче 300
-- знаков и короче нового; owner-decision не трогается; повтор — no-op.
-- Писатель в журнале — syshchik-sources.

-- ── Места (2) ──
WITH src(slug, txt, sources) AS (VALUES
  ('geologicheskij-muzej',
   'Геологический музей — экспозиция Камчатского филиала ФБУ «Территориальный фонд геологической информации по Дальневосточному федеральному округу». Филиал указывает её адрес: Петропавловск-Камчатский, посёлок Геологов, улица Беринга, 117.
Экспозиция разделена на три зала. В первом — минералы, раздел «Удивительное в мире камня» и изделия из самоцветов. Во втором — первооткрыватели Камчатки, золотые руды края и полезные ископаемые. В третьем — история геологических исследований Камчатки, вулканические бомбы, материалы Богачевской нефтеразведки, карта полезных ископаемых края, первые геологические карты, продукты извержения вулкана Толбачик и стенды «Геологи Камчатки в годы войны».
В музее проводят экскурсии по предварительной записи; расписание групп филиал публикует на странице музея. Для учащихся на базе экспозиции проходят лекции-экскурсии и беседы о геологии края.',
   '["http://www.tfikamchatka.ru/index.php?itemid=514&open=musm", "http://tfikamchatka.ru/index.php?art=37&open=article"]'::jsonb),
  ('vodopad-tahkoloch',
   'Водопад на реке Тахколоч — одна из ключевых достопримечательностей официального летнего маршрута «Горный массив Вачкажец» вместе с озером Тахколоч и ледниковым цирком горы Летняя Поперечная. Массив — памятник природы регионального значения, созданный 9 января 1981 года для охраны уникальных форм рельефа; маршрут проходит в Елизовском районе, на Южно-Быстринском хребте.
По паспорту маршрута подъезд такой: на 73-м километре дороги Петропавловск-Камчатский — Мильково поворот налево на гравийный технологический проезд вдоль газопровода, на 11-м километре газопровода — налево на лесную дорогу к озеру Тахколоч. На подготовленной машине можно доехать до автостоянки на границе охранной зоны; без неё пеший путь начинают от 11-го километра газопровода.
Тропа идёт к озеру, затем вдоль ручья Тахколоч по каскадам водопадов в цирк Летней Поперечной. Из цирка спускаются в долину Тахколоч и выходят к водопаду сверху; на спуске есть очень крутые участки и переход через реку, паспорт советует взять палки для ходьбы. Возвращаются тем же путём. Сезон маршрута — июнь–октябрь.',
   '["https://visitkamchatka.ru/upload/route_passports/vachkazh_summer.pdf", "https://visitkamchatka.ru/routes/gornyy-massiv-vachkazhets/"]'::jsonb)
),
old AS (
  SELECT t.id, t.ark_id AS entity_id, t.name AS title,
         LENGTH(t.description) AS prev_chars, s.txt, s.sources
    FROM places t
    JOIN src s ON (s.slug = t.slug OR t.ark_id::text = s.slug OR t.id::text = s.slug)
   WHERE char_length(COALESCE(btrim(t.description), '')) < 300
     AND char_length(COALESCE(btrim(t.description), '')) < char_length(s.txt)
     AND NOT EXISTS (
           SELECT 1 FROM description_provenance dp_owner
            WHERE dp_owner.entity_id = t.ark_id
              AND dp_owner.written_by = 'owner-decision')
),
upd AS (
  UPDATE places t
     SET description = old.txt, updated_at = NOW()
    FROM old
   WHERE t.id::text = old.id::text
  RETURNING old.entity_id, old.title, LENGTH(t.description) AS chars, old.prev_chars, old.sources
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.entity_id, 'place', upd.title, 'syshchik-sources', upd.sources,
       jsonb_array_length(upd.sources), upd.chars, upd.prev_chars
  FROM upd
 WHERE upd.entity_id IS NOT NULL;

-- ── Маршруты (2) ──
WITH src(slug, txt, sources) AS (VALUES
  ('lezhbishche-sivuchej-marshrut',
   'Сивуч (Eumetopias jubatus) — морской лев; вид занесён в Красную книгу. В апреле 2021 года министр природных ресурсов и экологии Камчатского края назвал места зимовки сивучей в черте Петропавловска-Камчатского: мысы Чавыча и Сигнальный и старый пирс в микрорайоне Моховая. Городские залежки этих животных, по его словам, есть всего в трёх местах мира: в Петропавловске-Камчатском, Невельске на Сахалине и Сан-Франциско.
Министерство и природоохранные организации предупреждают: кормить сивучей нельзя. С такой пищей в организм морских млекопитающих могут попасть болезнетворные микроорганизмы, а пищевое поведение животных меняется. Из-за продолжавшегося кормления Росприроднадзор тогда выдал владельцу пирса на Моховой предписание закрыть его для посещения.
Наблюдать за животными можно только со стороны, не подходя вплотную; актуальный режим посещения конкретной точки смотрите в сообщениях краевых ведомств.',
   '["https://kam24.ru/news/main/20210402/80639.html", "https://visitkamchatka.ru/activities/petropavlovsk-kamchatskiy/"]'::jsonb),
  ('gora-letnyaya-poperechnaya',
   'Гора Летняя Поперечная входит в горный массив Вачкажец: ледниковый цирк горы назван среди ключевых достопримечательностей официального летнего маршрута «Горный массив Вачкажец» — вместе с озером Тахколоч и водопадом на реке Тахколоч. Массив — памятник природы регионального значения, созданный 9 января 1981 года; он лежит в Елизовском районе, на Южно-Быстринском хребте.
Подъезд по паспорту маршрута: 73-й километр дороги Петропавловск-Камчатский — Мильково, технологический проезд вдоль газопровода и с его 11-го километра лесная дорога к озеру Тахколоч; на подготовленной машине — до автостоянки на границе охранной зоны, дальше пешком.
К цирку ведут две тропы от озера Тахколоч — справа и слева; левая после мостика идёт вдоль ручья Тахколоч по каскадам водопадов. Из цирка можно спуститься в долину к водопаду на реке Тахколоч: на спуске очень крутые участки и переход через реку. Сезон официального маршрута — июнь–октябрь.',
   '["https://visitkamchatka.ru/upload/route_passports/vachkazh_summer.pdf", "https://visitkamchatka.ru/routes/gornyy-massiv-vachkazhets/"]'::jsonb)
),
old AS (
  SELECT t.id, COALESCE(t.ark_id, t.id) AS entity_id, t.title AS title,
         LENGTH(t.description) AS prev_chars, s.txt, s.sources
    FROM kamchatka_routes t
    JOIN src s ON s.slug = t.slug
   WHERE char_length(COALESCE(btrim(t.description), '')) < 300
     AND char_length(COALESCE(btrim(t.description), '')) < char_length(s.txt)
     AND NOT EXISTS (
           SELECT 1 FROM description_provenance dp_owner
            WHERE dp_owner.entity_id = COALESCE(t.ark_id, t.id)
              AND dp_owner.written_by = 'owner-decision')
),
upd AS (
  UPDATE kamchatka_routes t
     SET description = old.txt, updated_at = NOW()
    FROM old
   WHERE t.id::text = old.id::text
  RETURNING old.entity_id, old.title, LENGTH(t.description) AS chars, old.prev_chars, old.sources
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.entity_id, 'route', upd.title, 'syshchik-sources', upd.sources,
       jsonb_array_length(upd.sources), upd.chars, upd.prev_chars
  FROM upd
 WHERE upd.entity_id IS NOT NULL;
