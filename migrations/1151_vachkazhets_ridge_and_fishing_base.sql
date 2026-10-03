-- Migration 1151: «Трек по хребту Вачкажец» сведён в «Вачкажец», описание массива — по источнику; рыболовная база скрыта
-- Created: 2026-10-03
--
-- Перепись prod-check run 82 (place-activity-census + places-by-type other)
-- нашла две видимые записи в places, чьё имя называет не объект местности.
-- Решения владельца 03.10:
--
--   · «Трек по хребту Вачкажец» (7846d641…) — «сведи» в гору «Вачкажец»
--     (c4310d06…, тот же массив, 53.081/157.931). Старое имя — псевдоним
--     главной записи, связи с маршрутами перевешиваются на неё (порядок
--     /api/admin/places/merge), дубль скрывается и помечается слитым.
--
--   · Описание «Вачкажца» — «перепиши». Нынешнее («древний взрыв разорвал
--     вулкан на части», «в чаше озера плавают айсберги») повторяет версию,
--     которую ru.wikipedia «Вачкажец» (версия 2025-07-16, прочитана с
--     раннера: chronicle-fetch, партия 23) прямо называет ошибочной: массив
--     — позднемиоценовые интрузии, поднятые тектоникой, признаков вулкана
--     нет. Новый текст — только из этой статьи; голос — справка
--     (descriptionVoice: plain). Сигнатура — начало нынешнего текста:
--     описание меняется, только пока оно прежнее. Строка в
--     description_provenance с written_by = 'owner-decision' — чтобы Editor
--     и enrich-places не переписали справку обратно (AGENT_PROMPT §7).
--     Варианты имени из той же статьи (Вачкажеч, Вацкажач) и «Горный массив
--     Вачкажец» — псевдонимы: по ним поиск находит место.
--
--   · «Река Камчатка — рыбалка» (9ad01c57…) — слово владельца: «это база на
--     реке Камчатка». Коммерческая база — не географический факт (§9).
--     Координаты 55.4/159.6 округлены до десятых, где база стоит, из записи
--     не следует. Скрытие мягкое и обратимое (is_visible), не удаление.
--     Отдельную карточку реки не заводим — решение владельца 03.10.
--
-- Правила: прицел по id И текущему состоянию — повторный прогон и ручная
-- правка до него дают no-op.

BEGIN;

-- ── Вачкажец: свод дубля ────────────────────────────────────────────────────
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe', t.name, t.source_name
  FROM places t
 WHERE t.id = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND t.merged_into_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE route_waypoints rw
   SET place_id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
 WHERE rw.place_id::text = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND NOT EXISTS (
     SELECT 1 FROM route_waypoints rw2
      WHERE rw2.route_id = rw.route_id
        AND rw2.place_id::text = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
   );
DELETE FROM route_waypoints
 WHERE place_id::text = '7846d641-ed72-42b9-846c-a87454d97b8f';

UPDATE places
   SET is_visible     = FALSE,
       merged_into_id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe',
       merged_at      = NOW(),
       updated_at     = NOW()
 WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND merged_into_id IS NULL
   AND EXISTS (SELECT 1 FROM places m
                WHERE m.id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
                  AND m.merged_into_id IS NULL);

-- ── Вачкажец: псевдонимы из источника ───────────────────────────────────────
INSERT INTO place_aliases (place_id, alias, source_name)
SELECT 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe', a, 'ru.wikipedia'
  FROM unnest(ARRAY['Вачкажеч', 'Вацкажач', 'Горный массив Вачкажец']) AS a
 WHERE EXISTS (SELECT 1 FROM places WHERE id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe')
ON CONFLICT DO NOTHING;

-- ── Вачкажец: описание по источнику ─────────────────────────────────────────
WITH old AS (
  SELECT id, LENGTH(description) AS prev_chars
    FROM places
   WHERE id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
     AND description LIKE 'С юга к Вачкажцу подходишь через мелкий ольховник%'
),
upd AS (
  UPDATE places p
     SET description = 'Вачкажец (Вачкажеч, устаревшее Вацкажач) — горный массив на юге Камчатки, в 80 км к западу от Петропавловска-Камчатского; памятник природы регионального значения. Высшая точка — гора Вачкажец, 1556 м. Долго считалось, что это древний вулкан, разорванный извержением на части, но по современным данным массив сложен интрузивными породами позднего миоцена и поднят тектоническими движениями; признаков отдельного вулкана у него нет, и в Государственной геологической карте он к вулканическим комплексам не отнесён. Нынешний рельеф — кары, цирки и троговые долины — оставил ледник площадью около 120 км², существовавший 60–10 тыс. лет назад; толщина льда достигала 150 м. К массиву ходят смотреть водопады, озеро Тахколоч, запруженное древним моренным валом, и восточный ледниковый цирк горы Летняя Поперечная: в его нижней части ледник был ещё в середине XIX века, теперь наверху остался лишь многолетний снежник. Летом здесь трекинг, наблюдение за птицами и цветами, зимой — лыжный туризм и фрирайд. На территории массива действуют ограничения, связанные со статусом памятника природы.',
         updated_at = NOW()
    FROM old
   WHERE p.id = old.id
  RETURNING p.ark_id, p.name, p.description, old.prev_chars
)
INSERT INTO description_provenance
  (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count,
   chars, previous_chars)
SELECT upd.ark_id, 'place', upd.name,
       -- Текст написан по решению владельца из названного источника, не машиной.
       'owner-decision',
       '["горный массив, 80 км к западу от Петропавловска-Камчатского","памятник природы регионального значения","высшая точка 1556 м","не вулкан: позднемиоценовые интрузии и тектоника","ледник около 120 км², 60–10 тыс. лет назад, лёд до 150 м","водопады, озеро Тахколоч, цирк Летней Поперечной","трекинг, птицы, цветы; зимой лыжи и фрирайд"]'::jsonb,
       7,
       LENGTH(upd.description),
       upd.prev_chars
  FROM upd
 WHERE upd.ark_id IS NOT NULL;

-- ── Рыболовная база: скрыть ─────────────────────────────────────────────────
UPDATE places SET is_visible = false, updated_at = NOW()
 WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f'
   AND name = 'Река Камчатка — рыбалка'
   AND is_visible = true;

COMMIT;

-- Rollback (описание прежним не восстанавливается — источник его опровергает):
-- BEGIN;
-- UPDATE places SET is_visible = true, merged_into_id = NULL, merged_at = NULL
--  WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f';
-- DELETE FROM place_aliases
--  WHERE place_id = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe'
--    AND alias IN ('Трек по хребту Вачкажец','Вачкажеч','Вацкажач','Горный массив Вачкажец');
-- UPDATE places SET is_visible = true
--  WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f' AND name = 'Река Камчатка — рыбалка';
-- COMMIT;
