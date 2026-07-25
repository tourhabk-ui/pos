-- Migration 772: реестр «эко» — двойная запись вместо суммы на лету
--
-- Этап 1 токенизации эко-баллов. Токеном вещь делает не блокчейн, а
-- неизменяемый учёт с доказуемым инвариантом. До этой миграции учёт был такой:
--
--   1. Баланс считался SUM(earn) - SUM(redeem) при каждом чтении
--      (lib/loyalty/loyalty-system.ts:75) — состояние было «мнением запроса».
--   2. Списание: сначала SELECT баланса, потом отдельный INSERT, без
--      транзакции и без блокировки (там же, :264-277). Два параллельных
--      списания уводили баланс в минус.
--   3. Минус не запрещался, а ПРЯТАЛСЯ: Math.max(0, availablePoints) (:140).
--   4. Типы 'expire' и 'refund' были в CHECK, но в расчёт баланса не входили —
--      декоративные операции, которые молча ничего не делали.
--   5. Дедуп начислений — обычный индекс (user_id, source, booking_id), не
--      UNIQUE, а проверка в коде через SELECT перед INSERT: снова гонка.
--
-- Что вводится:
--   eco_ledger   — журнал только на дозапись (UPDATE/DELETE запрещены триггером),
--                  каждая операция имеет счёт-источник и счёт-получатель.
--   eco_balances — материализованный баланс. Пользовательский счёт не может
--                  уйти в минус (CHECK), системные — контр-счета, их
--                  отрицательный баланс и есть объём эмиссии.
--
-- ИНВАРИАНТ: SUM(balance) по ВСЕМ счетам == 0. Одна строка проверки, которую
-- сторож гоняет каждый час; расхождение = crit-алерт.
--
-- Перенос: открывающая проводка (operation='opening') на тот баланс, который
-- пользователь РЕАЛЬНО видел на витрине (earn - redeem с учётом expires_at,
-- отрицательные обнулены). Старые expire/refund в баланс не входили и задним
-- числом не применяются — переписывать историю пользователя мы не вправе.
-- Таблица loyalty_transactions остаётся нетронутой как архив.
--
-- Идемпотентна: повторный прогон не создаёт вторых проводок (UNIQUE по
-- (source, source_ref)) и не портит балансы.

BEGIN;

-- ── Журнал ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eco_ledger (
  id             BIGSERIAL PRIMARY KEY,
  debit_account  TEXT   NOT NULL,
  credit_account TEXT   NOT NULL,
  amount         BIGINT NOT NULL,
  operation      TEXT   NOT NULL,
  source         TEXT   NOT NULL,
  source_ref     TEXT,
  description    TEXT   NOT NULL,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_ledger_amount_positive') THEN
    ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_amount_positive CHECK (amount > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_ledger_accounts_differ') THEN
    ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_accounts_differ CHECK (debit_account <> credit_account);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_ledger_operation_known') THEN
    ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_operation_known
      CHECK (operation IN ('opening', 'emit', 'redeem', 'transfer', 'expire', 'refund', 'adjust'));
  END IF;
END $$;

-- Идемпотентность операций: одно событие-источник — одна проводка.
-- Дедуп на уровне БД, а не SELECT-перед-INSERT в коде.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_ledger_idempotency
  ON eco_ledger (source, source_ref) WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eco_ledger_debit   ON eco_ledger (debit_account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eco_ledger_credit  ON eco_ledger (credit_account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eco_ledger_expires ON eco_ledger (expires_at) WHERE expires_at IS NOT NULL;

-- Только на дозапись: историю нельзя переписать даже из psql.
CREATE OR REPLACE FUNCTION eco_ledger_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'eco_ledger — журнал только на дозапись, операция % запрещена', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_eco_ledger_append_only ON eco_ledger;
CREATE TRIGGER trg_eco_ledger_append_only
  BEFORE UPDATE OR DELETE ON eco_ledger
  FOR EACH ROW EXECUTE FUNCTION eco_ledger_append_only();

-- ── Балансы ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eco_balances (
  account    TEXT PRIMARY KEY,
  balance    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_balances_no_overdraft') THEN
    ALTER TABLE eco_balances ADD CONSTRAINT eco_balances_no_overdraft
      CHECK (balance >= 0 OR account LIKE 'system:%');
  END IF;
END $$;

-- ── Перенос: открывающие проводки ────────────────────────────────────────────
-- Сумма — ровно та, что показывалась пользователю (Math.max(0, earn - redeem)
-- по неистёкшим записям). Не «как должно было быть», а «как было».
INSERT INTO eco_ledger (debit_account, credit_account, amount, operation, source, source_ref, description)
SELECT
  'system:opening',
  'user:' || t.user_id::text,
  t.bal,
  'opening',
  'migration_772',
  t.user_id::text,
  'Перенос баланса из loyalty_transactions (миграция 772)'
FROM (
  SELECT
    user_id,
    GREATEST(
      0,
      COALESCE(SUM(CASE WHEN type = 'earn'   THEN amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN type = 'redeem' THEN amount ELSE 0 END), 0)
    )::bigint AS bal
  FROM loyalty_transactions
  WHERE (expires_at IS NULL OR expires_at > NOW())
    AND type <> 'expire'
  GROUP BY user_id
) t
WHERE t.bal > 0
ON CONFLICT DO NOTHING;

-- Балансы держателей из открывающих проводок (существующие не трогаем —
-- миграция могла уже проходить, а поверх неё пошли живые операции).
INSERT INTO eco_balances (account, balance)
SELECT credit_account, SUM(amount)::bigint
FROM eco_ledger
WHERE operation = 'opening'
GROUP BY credit_account
ON CONFLICT (account) DO NOTHING;

-- Контр-счёт: его минус равен сумме открытых балансов, поэтому SUM по всем
-- счетам сходится в ноль. Пересчитывается из журнала — идемпотентно.
INSERT INTO eco_balances (account, balance)
SELECT 'system:opening', -COALESCE(SUM(amount), 0)::bigint
FROM eco_ledger
WHERE operation = 'opening'
ON CONFLICT (account) DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW();

-- Системные счета заводим сразу, чтобы первая же операция не гонялась за
-- созданием строки.
INSERT INTO eco_balances (account, balance) VALUES
  ('system:emission', 0),
  ('system:burn', 0),
  ('system:correction', 0)
ON CONFLICT (account) DO NOTHING;

COMMIT;
