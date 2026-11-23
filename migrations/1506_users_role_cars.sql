-- 1506: роль 'cars' (прокат автомобилей без водителя) разрешена в users.role.
-- Created: 2026-11-23
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- План готовности 23.11, этап 3a: у прокатчика автомобилей не было своего
-- входа. Категория карточки `cars` разрешена в partners давно (CHECK
-- partners_category_check) и уже живёт в коде: такой партнёр не входит в
-- список туроператоров, его страница — /car-rental/[slug], чат и заявки
-- знают его как прокат. А роли пользователя не было: CHECK users_role_check
-- (миграция 1026) разрешает восемь ролей, и запись role = 'cars' отвечала бы
-- 23514 — зарегистрироваться прокатчиком было нельзя.
--
-- Роль ↔ категория — одно слово, как у остальных партнёрских ролей
-- (lib/crm/partner-context: ROLE_TO_CATEGORY). Кабинет — существующий раздел
-- «Прокат» кабинета перевозчика (/hub/carrier/rental).
--
-- «Лагуна Прокат» заведена перевозчиком (category 'transfer', роль
-- 'transfer') с прайсом проката — миграция её не трогает: ни одна строка
-- users и partners не меняется.
--
-- Сторож: tests/unit/users-role-check-covers-code.test.ts — каждый список
-- ролей, который код пишет в users.role, обязан быть подмножеством этого
-- CHECK из последней миграции, его задающей.
--
-- ── Существующие строки ───────────────────────────────────────────────────
--
-- Новый список — надмножество прежнего. Если на проде окажется роль вне
-- списка, миграция не падает и чужих данных не переписывает: ограничение
-- ставится NOT VALID, а роли называются предупреждением (как в 1026).
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS, затем ADD.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

DO $$
DECLARE
  v_outside text;
BEGIN
  SELECT string_agg(DISTINCT role, ', ') INTO v_outside
    FROM users
   WHERE role IS NOT NULL
     AND role NOT IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear', 'cars');

  IF v_outside IS NULL THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
      role IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear', 'cars')
    );
  ELSE
    RAISE WARNING '[1506] в users есть роли вне списка (%): ограничение поставлено NOT VALID, старые строки не проверены', v_outside;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
      role IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear', 'cars')
    ) NOT VALID;
  END IF;
END $$;

COMMIT;

-- Откат: вернуть прежний список из 1026 — только если ни одной строки users
-- с ролью 'cars' нет. Текст ограничения здесь не повторяется намеренно:
-- сторож ролей читает последнее его определение в файле.
