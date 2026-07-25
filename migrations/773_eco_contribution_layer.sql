-- Migration 773: два слоя эко — вклад и польза
--
-- Решение владельца 25.07.2026 (docs/ECO.md): эко — свидетельство о вкладе,
-- а не средство обмена. Отсюда главное противоречие, которое схема обязана
-- закрыть: свидетельство теряет смысл, как только становится передаваемым.
-- Если вклад можно продать, человек с большим вкладом и человек с деньгами
-- выглядят одинаково.
--
-- Поэтому счёт держателя расщепляется надвое:
--
--   contrib:<user_id> — ВКЛАД. Накопительная история поступков, как разряд.
--                       Не тратится, не передаётся, не сгорает. Только растёт.
--                       Исправляется единственным способом — видимой проводкой
--                       operation='adjust' от system:correction.
--
--   user:<user_id>    — ПОЛЬЗА. Утилитарный слой: тратится на скидку, сгорает
--                       по сроку. Существует с миграции 772, поведение прежнее.
--
-- Одно действие порождает ОБЕ проводки: вклад фиксируется навсегда, польза
-- выдаётся к трате. Потратив пользу, человек не теряет вклад — именно это
-- отличает свидетельство от валюты.
--
-- Закон 8 («вклад не отчуждается») из docs/ECO.md после этой миграции держит
-- машина, а не наша дисциплина: списание с contrib-счёта запрещено триггером.
--
-- Инвариант сохранения не меняется: у слоя вклада свой контр-счёт
-- system:contribution, SUM(balance) по всем счетам по-прежнему обязан быть 0.
--
-- Идемпотентна.

BEGIN;

-- ── Контр-счёт слоя вклада ───────────────────────────────────────────────────
INSERT INTO eco_balances (account, balance)
VALUES ('system:contribution', 0)
ON CONFLICT (account) DO NOTHING;

-- ── Вклад неотчуждаем ────────────────────────────────────────────────────────
-- Единственное исключение — 'adjust': ручное исправление владельца, которое
-- всё равно остаётся видимой строкой журнала (Закон 9).
CREATE OR REPLACE FUNCTION eco_contribution_is_not_transferable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.debit_account LIKE 'contrib:%' AND NEW.operation <> 'adjust' THEN
    RAISE EXCEPTION
      'Вклад не отчуждается: списание с % запрещено (операция %). Тратится только польза (user:*).',
      NEW.debit_account, NEW.operation;
  END IF;

  -- Зачислять на счёт вклада можно только выпуском или переносом: перевод
  -- вклада от другого держателя — это та же продажа, только с другой стороны.
  IF NEW.credit_account LIKE 'contrib:%' AND NEW.operation NOT IN ('emit', 'opening', 'adjust') THEN
    RAISE EXCEPTION
      'На счёт вклада % нельзя зачислить операцией % — только emit/opening/adjust.',
      NEW.credit_account, NEW.operation;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_eco_contribution_not_transferable ON eco_ledger;
CREATE TRIGGER trg_eco_contribution_not_transferable
  BEFORE INSERT ON eco_ledger
  FOR EACH ROW EXECUTE FUNCTION eco_contribution_is_not_transferable();

-- ── Перенос: вклад = всё, что человек когда-либо заработал ───────────────────
-- Не текущий баланс (он уменьшался тратами), а сумма всех зачислений: вклад
-- не убывает от того, что человек воспользовался скидкой.
INSERT INTO eco_ledger (debit_account, credit_account, amount, operation, source, source_ref, description)
SELECT
  'system:contribution',
  'contrib:' || SUBSTRING(t.account FROM 6),
  t.earned,
  'opening',
  'migration_773',
  SUBSTRING(t.account FROM 6),
  'Перенос накопленного вклада (миграция 773)'
FROM (
  SELECT credit_account AS account, SUM(amount)::bigint AS earned
  FROM eco_ledger
  WHERE credit_account LIKE 'user:%'
    AND operation IN ('emit', 'opening', 'refund')
  GROUP BY credit_account
) t
WHERE t.earned > 0
ON CONFLICT DO NOTHING;

INSERT INTO eco_balances (account, balance)
SELECT credit_account, SUM(amount)::bigint
FROM eco_ledger
WHERE credit_account LIKE 'contrib:%'
GROUP BY credit_account
ON CONFLICT (account) DO NOTHING;

-- Контр-счёт пересчитывается из журнала — идемпотентно.
INSERT INTO eco_balances (account, balance)
SELECT 'system:contribution', -COALESCE(SUM(amount), 0)::bigint
FROM eco_ledger
WHERE credit_account LIKE 'contrib:%'
ON CONFLICT (account) DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW();

COMMIT;
