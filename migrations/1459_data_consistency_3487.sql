-- Migration 1459: сверка карточек туров, мест и маршрутов (#3487)
-- Created: 2026-11-17
--
-- Issue #3487 — сверка карточек по просьбе владельца 17.11. Решения по
-- каждому расхождению записаны в комментарии к issue («Решения для
-- разработчика») и дополнении к нему. Общее правило оттуда: противоречивый
-- или неподтверждённый факт о месте снимается, а не угадывается; слова
-- оператора, которые нужно уточнять у оператора, не переписываются по
-- догадке — из них уходит только спорная часть (§0, §4.0).
--
-- Здесь только данные. Правки кода из того же разбора (подъезд в длине
-- маршрута на карточке места, водитель и топливо у перевозчика) — в том же
-- PR отдельными файлами.
--
-- ── п.2. Узон (тур «Край Вулканов», 1176) ─────────────────────────────────
--
-- Шапка и API говорят «1–18 человек» (min_participants = 1, max = 18), а
-- описание и примечание к цене — «в составе сборной группы от 18 человек».
-- Что значит «от 18» (минимум для выезда группы или ошибка текста), знает
-- только оператор. До его ответа «от 18» уходит из обоих текстов, «сборная
-- группа» остаётся; min_participants не трогается. Скажет оператор, что
-- группа собирается от 18, — тогда min_participants = 18 и «от 18» везде.
--
-- ── п.10. Диаметр кальдеры Ксудача ────────────────────────────────────────
--
-- Три разных числа: «около 7 километров» в туре «Курильское озеро
-- (вертолёт)» (1217, Местечко Камчатка) и в облёте Лагуны Экспедиции (1339),
-- «6 км» в маршруте «Вулкан Ксудач» (089), а на карточке места диаметра нет
-- (снят 1247, текст 1288 его не называет). Сверенного источника нет — число
-- уходит из всех трёх. У Лагуны Экспедиции предложение с диаметром несёт и
-- глубину кальдеры, оно уходит целиком; глубина кратерного озера в следующем
-- предложении — слова оператора, она остаётся (вопрос оператору).
--
-- ── п.11. Облёт в туре «Курильское озеро (вертолёт)» (1217) ───────────────
--
-- Описание: «облетает вулканы Горелый и Мутновский», программа и краткое
-- описание: «Вилючинский и Горелый». Какой облёт на деле, знает «Местечко
-- Камчатка». До ответа предложение со списком из описания уходит: программа
-- остаётся источником для витрины и MCP.
--
-- ── п.14. Чужие снимки на карточках Ксудача и северной видовки ────────────
--
-- На карточке Ксудача стоит снимок по адресу /api/images/route/88d9d4c0-…
-- (это id места «Беленькая», 1247/1294), на «Северной видовке на Ксудач» —
-- /api/images/route/a1b2c3d4-… (вулкан Ходутка, снимок владельца 958).
-- Собственный герой места отдаётся по ЕГО ark_id; адрес героя другого места
-- может прийти только из прежних полей places.photo_url / places.images
-- (lib/places/place-detail берёт из них наши адреса). У этих двух мест из
-- обоих полей уходит каждый адрес /api/images/route/<id>, где id — не ark_id
-- самого места. Снимки самих Беленькой и Ходутки не трогаются. Не нашлось
-- такого адреса — WARNING: кадр пришёл другим путём, и гадать о нём здесь
-- нельзя. Своего снимка Ксудача в базе нет — карточка остаётся с заглушкой
-- по типу места (§9).
--
-- ── п.20. Высота Мутновского ──────────────────────────────────────────────
--
-- С карточки места высота уже снята. Тур облёта «Местечка» называет 2322 м
-- (1217), маршруты — 2323 м (089, два маршрута «Мутновский», и
-- visitkamchatka-ukp-tranzit — скрейп, в миграциях его текста нет). Без
-- одного источника число уходит из всех. Ключ metadata.height_m у маршрутов
-- 089 нигде не показывается и не трогается.
--
-- ── п.22. Дикие озерки (893, 967) ─────────────────────────────────────────
--
-- Текст 967 называет до Зеленовских озерков «3,4 км» и путь «около километра
-- по полю, дальше примерно 3,5 км», а блок «Рядом» считает 3 км. Правда
-- блока «Рядом» — посчитанное расстояние; километры из текста уходят, сам
-- путь (объехать базу слева, поле, лесная дорога) остаётся.
--
-- ── п.24. «Термальные источники Нальчева» — опечатка ─────────────────────
--
-- Правда — Налычева (долина Налычево, парк 1248). Место переименовывается,
-- прежнее имя остаётся псевдонимом (им место ищут), адрес по имени
-- (translit_ru_slug, 779/1112) меняется только если прежний был выведен из
-- имени с опечаткой и новый свободен среди мест и маршрутов. Старый адрес
-- /places/termalnye-istochniki-nalcheva уводит 308 на новый (next.config.js).
-- Тёзка-маршрут получает то же имя; его адрес (…-marshrut, 1112) не
-- меняется — он уже в индексе.
--
-- ── п.26, п.27. «Лагуна Прокат»: водитель и топливо (1318) ───────────────
--
-- Описание перевозчика говорило о двух машинах с водителем одной фразой, а
-- следом — «Топливо — за счёт арендатора, подача в аэропорт — по
-- согласованию». Условия строк прайса той же 1318 говорят по-разному: у Ford
-- Transit «водитель входит в стоимость — по сайту перевозчика; подача,
-- топливо и число часов в сутках не названы», у «Урала» — «входит ли
-- водитель в цену, не сказано». Фраза о топливе и подаче — пункты FAQ
-- проката: 1318 сама записала их условиями проката (car_rental_terms), а в
-- описании они встали рядом с машинами с водителем и читались как их
-- условие. Описание называет водителя по машине теми же словами, что прайс,
-- и относит топливо с подачей к прокату без водителя. Распространяется ли
-- тот пункт FAQ на машины с водителем, знает только прокатчик — это вопрос к
-- нему вместе с ценой «Урала» с водителем. Блок «Что входит в цену» теперь
-- печатает условия по каждой машине (lib/transfers/carrier-view, правка кода
-- в том же PR). Описание партнёра в журнал 911 не пишется: журнал ведёт
-- только места и маршруты.
--
-- ── Дополнение п.1. Евражки (туры гида Андрея Запорожца) ──────────────────
--
-- В программе: «Их можно покормить с рук», в правилах безопасности того же
-- тура: «Кормите евражек только тем, что разрешит гид. Не трогайте их
-- руками: они могут укусить». Решение: остаётся правило безопасности, совет
-- кормить с рук уходит. Обе фразы гид внёс в кабинете (в миграциях 1338 их
-- нет), поэтому правка — по самому тексту: только у тура, где стоят обе.
--
-- ── Чего здесь нет, и почему ──────────────────────────────────────────────
--   • п.17, маршрут «Ксудач и Ходутка» (242,5 км с подъездом): линия по
--     судье принадлежности (lib/routes/line-ownership) — own_with_approach:
--     «трогать её целиком нельзя — врёт не она, а число километров». Связь
--     с местом не переименовывается в «рядом» (§4.1 запрещает), длина не
--     стирается. Чинится показ: карточка места и Кузьмич называют такую
--     длину «вместе с подъездом» — правка кода в том же PR;
--   • п.19, «Каньон Крылья Гамулов (Дракон)» у Шивелуча: решение исходит из
--     того, что каньон на юге, у Вилючинского. Это неверно: миграция 988
--     записала слово владельца — каньон у Шивелуча, координату 56.566506 /
--     161.214709 он подтвердил дословно. Гамулы у Вилючинского перевала —
--     другой объект (980). Координата не трогается;
--   • Зеленовские озерки (п.15), Ходутка как место (п.16), Дзендзур (п.23),
--     нерка и медведи (п.13), Халактырское (п.21) — вне этой правки.
--
-- Журнал происхождения (911): каждая правка описания места и маршрута —
-- запись 'owner-decision' (решение по issue владельца) с фактами.
-- Идемпотентна: каждая правка — по точной фразе и только там, где фраза ещё
-- стоит; повтор ничего не меняет и журнал не дописывает.

BEGIN;

-- ═══ п.2. Узон: «от 18» уходит из текста ═════════════════════════════════

UPDATE operator_tours
   SET description = replace(description,
         'Экскурсия проходит в составе сборной группы от 18 человек.',
         'Экскурсия проходит в составе сборной группы.'),
       price_note = replace(price_note,
         'Цена за человека в составе сборной группы от 18 человек.',
         'Цена за человека в составе сборной группы.'),
       updated_at = NOW()
 WHERE slug = 'volcanoesland-dolina-geyzerov-kaldera-uzon'
   AND deleted_at IS NULL
   AND (COALESCE(description, '') LIKE '%сборной группы от 18 человек%'
        OR COALESCE(price_note, '') LIKE '%сборной группы от 18 человек%');

-- ═══ п.10, п.11. Курильское озеро (вертолёт): диаметр и спорный облёт ═══

UPDATE operator_tours
   SET description = replace(
         replace(description,
           'По пути вертолёт облетает вулканы Горелый и Мутновский с его фумарольными полями. ',
           ''),
         'посадка в кальдере вулкана Ксудач диаметром около 7 километров с кратерным озером',
         'посадка в кальдере вулкана Ксудач с кратерным озером'),
       updated_at = NOW()
 WHERE slug = 'mestechko-kurilskoe-ozero'
   AND deleted_at IS NULL
   AND (description LIKE '%облетает вулканы Горелый и Мутновский%'
        OR description LIKE '%Ксудач диаметром около 7 километров%');

-- п.10. Облёт Лагуны Экспедиции: предложение с диаметром и глубиной кальдеры.
UPDATE operator_tours
   SET description = replace(description,
         ' Созданная более 8 тысяч лет назад после катастрофического извержения вулкана, кальдера Ксудача имеет диаметр около 7 километров и глубину около 400 метров.',
         ''),
       updated_at = NOW()
 WHERE slug = 'lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya'
   AND deleted_at IS NULL
   AND description LIKE '%кальдера Ксудача имеет диаметр около 7 километров%';

-- п.10. Маршрут «Вулкан Ксудач» (089, 1110).
WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM kamchatka_routes
   WHERE id = '7a645b02-4574-4f99-b2c5-56f34dfd91e5'
), upd AS (
  UPDATE kamchatka_routes r
     SET description = replace(r.description,
           ' с грандиозной кальдерой диаметром 6 км.',
           ' с грандиозной кальдерой.'),
         updated_at = NOW()
    FROM old
   WHERE r.id::text = old.id::text
     AND r.description LIKE '%кальдерой диаметром 6 км.%'
  RETURNING r.id, r.title, r.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.id, 'route', upd.title, 'owner-decision',
       '["текст 089 без «диаметром 6 км»: диаметр кальдеры Ксудача в источниках расходится (6 и около 7 км), сверенного нет — число снято (#3487, п.10)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd;

-- ═══ п.20. Высота Мутновского ═══════════════════════════════════════════

UPDATE operator_tours
   SET description = replace(description, 'Мутновский (2322 м) — две вершины', 'Мутновский — две вершины'),
       updated_at = NOW()
 WHERE slug = 'mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy'
   AND deleted_at IS NULL
   AND description LIKE '%Мутновский (2322 м)%';

-- Маршруты «Мутновский» (089).
WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM kamchatka_routes
   WHERE id IN ('9f8d4b00-0378-475d-b861-12f7254f45a7', '874283be-6572-40c6-ac4e-7210f090b7a1')
), upd AS (
  UPDATE kamchatka_routes r
     SET description = replace(r.description, 'Мутновский (2323 м) — ', 'Мутновский — '),
         updated_at = NOW()
    FROM old
   WHERE r.id::text = old.id::text
     AND r.description LIKE '%Мутновский (2323 м) — %'
  RETURNING r.id, r.title, r.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.id, 'route', upd.title, 'owner-decision',
       '["текст 089 без «(2323 м)»: высота Мутновского в источниках платформы расходится (2322 и 2323 м), с карточки места она снята — снята и здесь (#3487, п.20)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd;

-- Маршрут visitkamchatka-ukp-tranzit (скрейп, текста в миграциях нет).
WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM kamchatka_routes
   WHERE slug = 'visitkamchatka-ukp-tranzit'
), upd AS (
  UPDATE kamchatka_routes r
     SET description = replace(r.description, 'к Мутновскому вулкану (2323 метра)', 'к Мутновскому вулкану'),
         updated_at = NOW()
    FROM old
   WHERE r.id::text = old.id::text
     AND r.description LIKE '%к Мутновскому вулкану (2323 метра)%'
  RETURNING r.id, r.title, r.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.id, 'route', upd.title, 'owner-decision',
       '["текст маршрута без «(2323 метра)»: высота Мутновского в источниках платформы расходится (2322 и 2323 м), с карточки места она снята — снята и здесь (#3487, п.20)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd;

-- ═══ п.22. Дикие озерки: километры до Зеленовских уходят из текста ═══════

WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM places
   WHERE id::text = '36214e49-de02-4d1b-8f71-1926a1b319fa'
), upd AS (
  UPDATE places p
     SET description = replace(p.description,
           'Подъезд со стороны Зеленовских озерков (до них 3,4 км): от парковки базы объехать её слева, около километра по полю, дальше лесная дорога ещё примерно 3,5 км.',
           'Подъезд со стороны Зеленовских озерков: от парковки базы объехать её слева, дальше по полю и лесной дороге.'),
         updated_at = NOW()
    FROM old
   WHERE p.id::text = old.id::text
     AND p.description LIKE '%Зеленовских озерков (до них 3,4 км)%'
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name, 'owner-decision',
       '["текст 893/967 без километров до Зеленовских озерков (3,4 км и путь 1 + 3,5 км): расстояние на карточке одно — в блоке «Рядом», посчитанное по координатам (#3487, п.22)"]'::jsonb,
       1, LENGTH(upd.description), upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- ═══ п.14. Адреса героев других мест у Ксудача и северной видовки ════════
--
-- Адрес /api/images/route/<id> чужой, когда id не равен ark_id самого места.
-- Другие адреса (галерея места, наши файлы) не трогаются.

UPDATE places p
   SET photo_url = CASE
         WHEN p.photo_url ~ '/api/images/route/[0-9a-fA-F-]{36}'
          AND substring(p.photo_url FROM '/api/images/route/([0-9a-fA-F-]{36})') IS DISTINCT FROM p.ark_id::text
         THEN NULL
         ELSE p.photo_url
       END,
       images = CASE
         WHEN jsonb_typeof(p.images) = 'array' THEN COALESCE((
           SELECT jsonb_agg(e ORDER BY ord)
             FROM jsonb_array_elements(p.images) WITH ORDINALITY AS t(e, ord)
            WHERE NOT (jsonb_typeof(e) = 'string'
                       AND (e #>> '{}') ~ '/api/images/route/[0-9a-fA-F-]{36}'
                       AND substring((e #>> '{}') FROM '/api/images/route/([0-9a-fA-F-]{36})') IS DISTINCT FROM p.ark_id::text)
         ), '[]'::jsonb)
         ELSE p.images
       END,
       updated_at = NOW()
 WHERE p.id::text IN ('6e3a46a9-104d-4181-958a-2a47698f2982', '94220a7c-c4bb-4b16-8147-430b5e770617')
   AND (
     (p.photo_url ~ '/api/images/route/[0-9a-fA-F-]{36}'
      AND substring(p.photo_url FROM '/api/images/route/([0-9a-fA-F-]{36})') IS DISTINCT FROM p.ark_id::text)
     OR (jsonb_typeof(p.images) = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(p.images) AS e
        WHERE jsonb_typeof(e) = 'string'
          AND (e #>> '{}') ~ '/api/images/route/[0-9a-fA-F-]{36}'
          AND substring((e #>> '{}') FROM '/api/images/route/([0-9a-fA-F-]{36})') IS DISTINCT FROM p.ark_id::text))
   );

-- ═══ п.24. Налычева вместо «Нальчева» ════════════════════════════════════

-- Прежнее имя — псевдонимом: так место ищут по старым ссылкам и спискам.
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT p.id::text, 'Термальные источники Нальчева', 'typo-1459'
  FROM places p
 WHERE p.id::text = '4d46f8c3-c8c6-442e-8f73-02e683fd5f15'
   AND p.name = 'Термальные источники Нальчева'
ON CONFLICT DO NOTHING;

-- Адрес по имени: только если прежний выведен из имени с опечаткой, а новый
-- свободен везде. Иначе адрес остаётся, и это слышно в исходе ниже.
UPDATE places p
   SET slug = translit_ru_slug('Термальные источники Налычева'),
       updated_at = NOW()
 WHERE p.id::text = '4d46f8c3-c8c6-442e-8f73-02e683fd5f15'
   AND p.slug = translit_ru_slug('Термальные источники Нальчева')
   AND NOT EXISTS (SELECT 1 FROM places x WHERE x.slug = translit_ru_slug('Термальные источники Налычева'))
   AND NOT EXISTS (SELECT 1 FROM kamchatka_routes r WHERE r.slug = translit_ru_slug('Термальные источники Налычева'));

UPDATE places
   SET name = 'Термальные источники Налычева',
       updated_at = NOW()
 WHERE id::text = '4d46f8c3-c8c6-442e-8f73-02e683fd5f15'
   AND name = 'Термальные источники Нальчева';

-- Тёзка-маршрут: имя то же, адрес прежний.
UPDATE kamchatka_routes
   SET title = 'Термальные источники Налычева',
       updated_at = NOW()
 WHERE title = 'Термальные источники Нальчева';

-- ═══ Дополнение п.1. Евражки: совет кормить с рук уходит ═════════════════

UPDATE operator_tours t
   SET program = (
         SELECT jsonb_agg(
                  CASE
                    WHEN jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'text') = 'string'
                    THEN jsonb_set(e, '{text}', to_jsonb(btrim(regexp_replace(
                           e ->> 'text', '\s*Их можно покормить с рук[^.!?]*[.!?]?', '', 'g'))))
                    ELSE e
                  END ORDER BY ord)
           FROM jsonb_array_elements(t.program) WITH ORDINALITY AS x(e, ord)
       ),
       updated_at = NOW()
 WHERE t.deleted_at IS NULL
   AND jsonb_typeof(t.program) = 'array'
   AND t.program::text LIKE '%Их можно покормить с рук%'
   AND array_to_string(t.safety_notes, ' ') LIKE '%Кормите евражек только тем, что разрешит гид%';

UPDATE operator_tours t
   SET description = btrim(regexp_replace(t.description, '\s*Их можно покормить с рук[^.!?]*[.!?]?', '', 'g')),
       updated_at = NOW()
 WHERE t.deleted_at IS NULL
   AND t.description LIKE '%Их можно покормить с рук%'
   AND array_to_string(t.safety_notes, ' ') LIKE '%Кормите евражек только тем, что разрешит гид%';

-- ═══ п.26, п.27. «Лагуна Прокат»: водитель по машине, топливо — у проката ═══
UPDATE partners
   SET description = replace(description,
         'С водителем, целой машиной за сутки: Ford Transit на 17 мест и вахтовка «Урал» на 25 мест. Топливо — за счёт арендатора, подача в аэропорт — по согласованию.',
         'С водителем, целой машиной за сутки: Ford Transit на 17 мест — водитель входит в стоимость, по сайту перевозчика; вахтовка «Урал» на 25 мест — входит ли водитель в цену, сайт не говорит. При прокате без водителя топливо — за счёт арендатора, подача в аэропорт — по согласованию.')
 WHERE slug = 'laguna-prokat'
   AND description LIKE '%Ford Transit на 17 мест и вахтовка «Урал» на 25 мест. Топливо — за счёт арендатора, подача в аэропорт — по согласованию.%';

-- ═══ Исход ═══════════════════════════════════════════════════════════════
-- Чего правка не нашла, не выдаётся за «исправлено»: оставшееся — WARNING.
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM operator_tours
   WHERE deleted_at IS NULL
     AND slug = 'volcanoesland-dolina-geyzerov-kaldera-uzon'
     AND (COALESCE(description, '') || ' ' || COALESCE(price_note, '')) LIKE '%от 18 человек%';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] Узон: «от 18 человек» осталось в тексте — он отличается от записанного 1176, поправить руками';
  END IF;

  SELECT count(*) INTO v_n FROM operator_tours
   WHERE deleted_at IS NULL
     AND (COALESCE(description, '') ~ 'Ксудач[а-я]*[^.]*диаметр'
          OR (slug = 'mestechko-kurilskoe-ozero' AND description LIKE '%Горелый и Мутновский%'));
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у % тур(ов) остался диаметр кальдеры Ксудача или спорный облёт — текст отличается от записанного 1217/1339', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM kamchatka_routes
   WHERE COALESCE(description, '') ~ '(кальдерой диаметром 6 км|Мутновский \(2323 м\)|Мутновскому вулкану \(2323 метра\))';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у % маршрут(ов) остался диаметр Ксудача или высота Мутновского — поправить руками', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM operator_tours
   WHERE deleted_at IS NULL AND COALESCE(description, '') LIKE '%Мутновский (2322 м)%';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] высота Мутновского осталась в описании облёта — текст отличается от записанного 1217';
  END IF;

  SELECT count(*) INTO v_n FROM kamchatka_routes WHERE slug = 'visitkamchatka-ukp-tranzit';
  IF v_n = 0 THEN
    RAISE WARNING '[1459] маршрута visitkamchatka-ukp-tranzit нет — высоту в нём проверить не на чем';
  END IF;

  SELECT count(*) INTO v_n FROM places
   WHERE id::text = '36214e49-de02-4d1b-8f71-1926a1b319fa'
     AND COALESCE(description, '') ~ '(3,4 км|3,5 км)';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] Дикие озерки: километры до Зеленовских остались в тексте — он отличается от записанного 967';
  END IF;

  SELECT count(*) INTO v_n FROM places p
   WHERE p.id::text IN ('6e3a46a9-104d-4181-958a-2a47698f2982', '94220a7c-c4bb-4b16-8147-430b5e770617')
     AND (COALESCE(p.photo_url, '') || ' ' || COALESCE(p.images::text, '')) ~ '/api/images/route/'
     AND (COALESCE(p.photo_url, '') || ' ' || COALESCE(p.images::text, '')) !~ ('/api/images/route/' || COALESCE(p.ark_id::text, '-'));
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у Ксудача или северной видовки остался адрес чужого героя — разобрать руками';
  END IF;
  SELECT count(*) INTO v_n FROM places p
   WHERE p.id::text IN ('6e3a46a9-104d-4181-958a-2a47698f2982', '94220a7c-c4bb-4b16-8147-430b5e770617')
     AND EXISTS (SELECT 1 FROM ai_route_images ai
                  WHERE ai.route_id = p.ark_id AND ai.model IN ('wikimedia', 'manual-upload'));
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у % из двух мест (Ксудач, северная видовка) есть СВОЙ показываемый герой — миграция его не трогала, проверить глазами, тот ли это объект', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM places
   WHERE id::text = '4d46f8c3-c8c6-442e-8f73-02e683fd5f15'
     AND slug IS DISTINCT FROM translit_ru_slug('Термальные источники Налычева');
  IF v_n > 0 THEN
    RAISE WARNING '[1459] адрес места «Термальные источники Налычева» не сменился — переадресация старого адреса в next.config.js ведёт в пустоту, снять её';
  END IF;
  SELECT count(*) INTO v_n FROM places WHERE name LIKE '%Нальчева%';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у % мест(а) осталось имя с опечаткой «Нальчева»', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM partners
   WHERE slug = 'laguna-prokat'
     AND COALESCE(description, '') NOT LIKE '%вахтовка «Урал» на 25 мест — входит ли водитель в цену, сайт не говорит%';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] «Лагуна Прокат»: описание отличается от записанного 1318 — водитель и топливо по машинам не разведены, поправить руками';
  END IF;

  SELECT count(*) INTO v_n FROM operator_tours
   WHERE deleted_at IS NULL
     AND (COALESCE(program::text, '') || ' ' || COALESCE(description, '')) LIKE '%покормить с рук%';
  IF v_n > 0 THEN
    RAISE WARNING '[1459] у % тур(ов) остался совет кормить евражек с рук — у них нет правила безопасности о кормлении, разобрать руками', v_n;
  END IF;
END $$;

COMMIT;
