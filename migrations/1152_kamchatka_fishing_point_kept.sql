-- Migration 1152: «Река Камчатка — рыбалка» остаётся видимой точкой
-- Created: 2026-10-03
--
-- Миграция 1151 скрыла запись 9ad01c57… как рыболовную базу (§9). Владелец
-- 03.10, после влития 1151: «точку оставь». Возвращаем видимость — только
-- её; имя, тип и описание не трогаются.
--
-- Прицел по id, имени и текущей видимости: если запись уже видима или
-- переименована — no-op.

BEGIN;

UPDATE places SET is_visible = true, updated_at = NOW()
 WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f'
   AND name = 'Река Камчатка — рыбалка'
   AND is_visible = false
   AND merged_into_id IS NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE places SET is_visible = false
--  WHERE id = '9ad01c57-7c24-4515-b92d-698bd9a1cb5f' AND name = 'Река Камчатка — рыбалка';
-- COMMIT;
