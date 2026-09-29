-- 1105: «Камчатская рыбалка» — контакты «только Анатолий» по-настоящему
--       и кнопка формы заявки в цвет сайта партнёра.
--
-- ── Почему 1103 не сработала ────────────────────────────────────────────
--
-- 1103 правила `partners.contacts` как ОБЪЕКТ (`contacts - 'phone2'`,
-- `|| jsonb_build_object('phone', ...)`), а у этого партнёра там МАССИВ
-- объектов (так его сложили 840–844). На массиве `- 'ключ'` удаляет только
-- элементы-СТРОКИ с таким текстом — то есть ничего, а `||` с объектом
-- дописывает девятый элемент. Условие `contacts->>'phone' IS DISTINCT FROM`
-- на массиве даёт NULL и всегда истинно. Итог на проде 29.09 (ответ
-- /api/operators/fishingkam): «Александр · Гид +79992997007», «Офис
-- +79247808011» (номер, который партнёр просил убрать), личный Telegram
-- labanalex — всё на месте, плюс лишний {"phone": "+79147822222"} в конце.
-- Поля `contact` («+79147822222, +7 (999) 299-70-07») и `features`
-- («Анатолий и Александр — местные профессионалы») 1103 не трогала вовсе.
--
-- Слова партнёра те же (владелец 29.09): «Александра удали, он уволился»,
-- «номер +7 924 780-80-11 убери». Остаётся Анатолий, +7 914 782-22-22.
--
-- ── Как чистится массив ─────────────────────────────────────────────────
--
-- Поэлементно, по значениям, а не по позициям: позиции не гарантированы.
--   * элемент с name «Александр…» — удаляется целиком;
--   * ключи, чьё значение — номер Александра, номер офиса или labanalex, —
--     удаляются из элемента (остальные поля элемента, адрес офиса, часы
--     работы, канал KamFishing_41, живут дальше);
--   * `phone2` без `phone` становится `phone`;
--   * опустевшие элементы и точные дубли уходят.
-- Порядок оставшихся сохраняется (WITH ORDINALITY).
--
-- Гейт по id (из 863) и по наличию снимаемых значений — идемпотентно.

WITH bad(v) AS (
  VALUES ('+79992997007'), ('+79247808011'), ('labanalex')
), cleaned AS (
  SELECT p.id,
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY first_ord), '[]'::jsonb)
             FROM (
               SELECT elem, MIN(ord) AS first_ord
                 FROM (
                   SELECT CASE
                            WHEN NOT (e3 ? 'phone') AND e3 ? 'phone2'
                              THEN (e3 - 'phone2') || jsonb_build_object('phone', e3->'phone2')
                            ELSE e3
                          END AS elem,
                          ord
                     FROM (
                       SELECT (
                                SELECT COALESCE(jsonb_object_agg(k, val), '{}'::jsonb)
                                  FROM jsonb_each(e.value) AS kv(k, val)
                                 WHERE NOT (jsonb_typeof(val) = 'string'
                                            AND val #>> '{}' IN (SELECT v FROM bad))
                              ) AS e3,
                              e.ord
                         FROM jsonb_array_elements(p.contacts) WITH ORDINALITY AS e(value, ord)
                        WHERE jsonb_typeof(e.value) = 'object'
                          AND COALESCE(e.value->>'name', '') NOT ILIKE 'Александр%'
                     ) s1
                 ) s2
                WHERE elem <> '{}'::jsonb
                GROUP BY elem
             ) s3
         ) AS contacts
    FROM partners p
   WHERE p.id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
     AND jsonb_typeof(p.contacts) = 'array'
     AND (p.contacts::text ~ '(79992997007|79247808011|labanalex)'
          OR p.contacts @> '[{"name": "Александр"}]')
)
UPDATE partners p
   SET contacts = c.contacts,
       updated_at = NOW()
  FROM cleaned c
 WHERE p.id = c.id;

-- Строка-сводка `contact.phone`: только Анатолий.
UPDATE partners
   SET contact = jsonb_set(contact, '{phone}', to_jsonb('+79147822222'::text)),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND jsonb_typeof(contact) = 'object'
   AND contact->>'phone' IS DISTINCT FROM '+79147822222';

-- «Опытные гиды»: из текста уходит Александр. Правится только элемент,
-- где он назван, и только эта фраза; выдумывать нового гида нельзя.
UPDATE partners
   SET features = (
         SELECT jsonb_agg(
                  CASE
                    WHEN f.value->>'desc' = 'Анатолий и Александр — местные профессионалы с многолетним опытом.'
                      THEN jsonb_set(f.value, '{desc}', to_jsonb('Анатолий — местный профессионал с многолетним опытом.'::text))
                    ELSE f.value
                  END
                  ORDER BY f.ord)
           FROM jsonb_array_elements(features) WITH ORDINALITY AS f(value, ord)
       ),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND jsonb_typeof(features) = 'array'
   AND features::text LIKE '%Анатолий и Александр — местные профессионалы с многолетним опытом.%';

-- Кнопка формы заявки — в цвет сайта партнёра и выше его нижних плашек.
-- #003466 — фон кнопок fishingkam.ru («РАССЧИТАТЬ СТОИМОСТЬ», «ЧИТАТЬ
-- ПОДРОБНЕЕ»), снят computed style 29.09 (просьба владельца «кнопку сделай в
-- цвет их лендинга»). bottom 120: на 390 px их cookie-плашка занимает ~100 px
-- снизу, на 1440 cookie-плашка кончается на 95 px, «Связаться с нами» — на
-- 110 px (примерка 29.09). Остальные ключи конфига не трогаются.
UPDATE partners
   SET widget_config = COALESCE(widget_config, '{}'::jsonb)
                       || jsonb_build_object('accentColor', '#003466', 'bottom', 120),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND (widget_config->>'accentColor' IS DISTINCT FROM '#003466'
     OR widget_config->>'bottom' IS DISTINCT FROM '120');
