-- Migration 1495: тестовый профиль партнёра — не на витрине.
-- Created: 2026-11-22
--
-- Слово владельца 24.10: отметка «тестовый профиль», которую ставит только
-- администратор, — и поставить её тестовому оператору FLO (flo@vedarai.ru):
-- тестовый профиль не появляется ни в каталоге, ни в списке компаний, ни в
-- поиске, ни в ответах MCP. 22.11 владелец подтвердил («да») — часть 2
-- закрытого PR #2770.
--
-- Как держится:
--  - карточка: тестовый профиль не может стоять на витрине — CHECK ниже.
--    Около сорока читателей карточек компаний уже спрашивают is_public, и
--    правило доходит до каждого, в том числе до будущих: забыть его нельзя;
--  - туры: шлюз витрины publicTourSql (lib/tours/public-visibility.ts)
--    не пускает тур тестового партнёра — каталог, поиск, план, Кузьмич и MCP
--    зовут этот шлюз.
--
-- Колонка по умолчанию ложь: живые компании не прячутся. FLO — карточка
-- оператора с этой почтой, если она есть; нет строки — миграция ничего не
-- выдумывает. Снятие отметки на витрину карточку само не возвращает:
-- вернуть её — решение администратора.

BEGIN;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN partners.is_test IS
  'Тестовый профиль: карточка и туры не на витрине. Ставит администратор (PATCH /api/admin/operators/[id]/test-profile).';

UPDATE partners p
   SET is_test = TRUE,
       is_public = FALSE,
       updated_at = NOW()
  FROM users u
 WHERE u.id::text = p.user_id::text
   AND lower(u.email) = 'flo@vedarai.ru'
   AND p.category = 'operator'
   AND (p.is_test IS DISTINCT FROM TRUE OR p.is_public IS DISTINCT FROM FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'partners_test_not_public'
       AND conrelid = 'partners'::regclass
  ) THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_test_not_public CHECK (NOT (is_test AND is_public IS TRUE));
  END IF;
END $$;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_test_not_public;
-- ALTER TABLE partners DROP COLUMN IF EXISTS is_test;
-- COMMIT;
