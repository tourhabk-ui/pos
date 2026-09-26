-- 1026: роли 'stay' и 'gear' разрешены в users.role.
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- CHECK `users_role_check` (baseline, lib/database/baseline/schema-baseline.sql)
-- разрешал ровно шесть ролей: tourist, operator, guide, transfer, agent,
-- admin. Код при этом ПИШЕТ в users.role ещё две — 'stay' (владелец жилья) и
-- 'gear' (прокат снаряжения). Каждая такая запись отвечала 23514
-- (check_violation): владелец жилья не мог ни зарегистрироваться, ни
-- переключиться на кабинет жилья, ни быть заведён администратором.
--
-- ── Какие роли код пишет на самом деле (сверено 26.09 по коду, не по памяти)
--
--   INSERT INTO users:
--     app/api/auth/register/route.ts       VALID_ROLES: tourist, operator,
--                                          guide, transfer, agent, stay, gear
--     app/api/partners/register/route.ts   roles[0]: operator, transfer,
--                                          stay, gear, guide
--     app/api/auth/register-operator       category ∈ PARTNER_ROLES
--                                          (lib/auth/role-routes.ts):
--                                          operator, guide, transfer, agent,
--                                          stay, gear
--     app/api/admin/operators/create       categories ∈ PARTNER_ROLES
--     app/api/admin/users/create-agent     'agent'
--     app/api/admin/import-mestechko       'operator'
--     app/api/auth/telegram, auth/max      'tourist'
--   UPDATE users SET role:
--     app/api/auth/switch-role             SWITCHABLE_ROLES
--                                          (lib/auth/role-switch.ts): tourist,
--                                          operator, guide, transfer, agent,
--                                          stay, gear, admin
--     app/api/roles (admin)                tourist, operator, guide, transfer,
--                                          agent, admin, stay, gear
--
-- Итог — восемь ролей: tourist, operator, guide, transfer, agent, admin,
-- stay, gear. 'transfer_operator' есть в типе AuthRole (lib/auth.ts), но
-- ни один путь его в базу НЕ пишет — в список он не вносится: разрешать то,
-- чего никто не производит, значит объявлять исход без источника.
--
-- Сторож: tests/unit/users-role-check-covers-code.test.ts — каждый список
-- ролей, который код пишет в users.role, обязан быть подмножеством этого
-- CHECK из последней миграции, его задающей.
--
-- ── Существующие строки ───────────────────────────────────────────────────
--
-- Новый список — надмножество прежнего, значит строки, прошедшие прежнюю
-- проверку, проходят и эту. Если же на проде окажется роль вне списка
-- (прежнее ограничение могли когда-то снимать руками), миграция не падает
-- и не переписывает чужие данные: ограничение ставится NOT VALID —
-- новые записи проверяются, старые остаются, — и роли называются вслух
-- предупреждением.
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
     AND role NOT IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear');

  IF v_outside IS NULL THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
      role IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear')
    );
  ELSE
    RAISE WARNING '[1026] в users есть роли вне списка (%): ограничение поставлено NOT VALID, старые строки не проверены', v_outside;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
      role IN ('tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear')
    ) NOT VALID;
  END IF;
END $$;

COMMIT;
