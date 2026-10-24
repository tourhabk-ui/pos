-- 1331: тестовый профиль партнёра скрыт с витрины.
--
-- Слово владельца 24.10: «Add an admin-only way to mark a partner profile as
-- test/hidden from storefront … and set it for the FLO test operator
-- (flo@vedarai.ru); test profiles must never appear in catalog, operators
-- list, search, MCP/API results.»
--
-- Колонка по умолчанию ложь: живые компании не прячутся. Отметку меняет
-- только администратор. FLO — операторская карточка этой почты, если она
-- уже есть; нет строки — миграция ничего не выдумывает.

BEGIN;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN partners.is_test IS
  'Тестовый профиль: не показывается на витрине. Ставит администратор.';

UPDATE partners p
   SET is_test = TRUE
  FROM users u
 WHERE u.id = p.user_id
   AND lower(u.email) = 'flo@vedarai.ru'
   AND p.category = 'operator';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE partners DROP COLUMN IF EXISTS is_test;
-- COMMIT;
