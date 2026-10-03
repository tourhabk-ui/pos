-- Migration 1151: «Трек по хребту Вачкажец» — это хребет; «Река Камчатка — рыбалка» — база, не место
-- Created: 2026-10-03
--
-- Перепись prod-check run 82 (place-activity-census + places-by-type other)
-- нашла две видимые записи в places, чьё имя называет не объект местности.
-- Решения владельца 03.10:
--
--   · «Трек по хребту Вачкажец» (7846d641…) — «Хребет Вачкажец». Имя
--     называет объект, не путь (§13). Тип other → mountain (так же лежат
--     «Вачкажец» и «Водопад, горный массив Вачкажец»). Старое имя — в
--     псевдонимы, чтобы поиск по нему не умер (порядок 851).
--     Оговорка: «Вачкажец» (гора, 53.081/157.931) — тот же массив; свод в
--     одну запись — отдельное решение, здесь не делается. Описание записи
--     говорит о тропе, а не о хребте — не трогается, ждёт переписи.
--
--   · «Река Камчатка — рыбалка» (9ad01c57…) — слово владельца: «это база на
--     реке Камчатка». Коммерческая база — не географический факт (§9: точка
--     = место, тур = коммерция). Координаты 55.4/159.6 округлены до десятых,
--     где база стоит, из записи не следует. Скрытие мягкое и обратимое
--     (is_visible), запись не удаляется — тот же приём, что 740/859.
--
-- Правила: прицел по id И текущему имени/типу/видимости — повторный прогон
-- и ручная правка до него дают no-op.

BEGIN;

INSERT INTO place_aliases (place_id, alias, source_name)
SELECT id::text, name, source_name
  FROM places
 WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND name = 'Трек по хребту Вачкажец'
ON CONFLICT DO NOTHING;

UPDATE places SET location_type = 'mountain'
 WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND location_type = 'other';

UPDATE places SET name = 'Хребет Вачкажец'
 WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f'
   AND name = 'Трек по хребту Вачкажец';

UPDATE places SET is_visible = false
 WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f'
   AND name = 'Река Камчатка — рыбалка'
   AND is_visible = true;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE places SET name = 'Трек по хребту Вачкажец', location_type = 'other'
--  WHERE id = '7846d641-ed72-42b9-846c-a87454d97b8f' AND name = 'Хребет Вачкажец';
-- DELETE FROM place_aliases
--  WHERE place_id = '7846d641-ed72-42b9-846c-a87454d97b8f' AND alias = 'Трек по хребту Вачкажец';
-- UPDATE places SET is_visible = true
--  WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f' AND name = 'Река Камчатка — рыбалка';
-- COMMIT;
