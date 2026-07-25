-- Migration 774: обязательства по скидкам эко
--
-- Закон 5 из docs/ECO.md: эмиссия обеспечена стоком. Решение владельца
-- 25.07.2026 — две фазы: пока активных операторов меньше двадцати, скидку
-- компенсирует платформа из комиссии; с двадцатого обязательство переходит к
-- операторам, но доля чека под эко становится меньше.
--
-- Без этой таблицы «платформа компенсирует» — просто слова: не с чем
-- сверяться и нечего предъявить. Здесь каждое списание эко превращается в
-- именованное денежное обязательство.
--
-- Почему отдельная таблица, а не колонка в eco_ledger: движение эко и
-- денежное обязательство — разные сущности. Журнал остаётся чистой двойной
-- записью по эко, обязательства живут своей жизнью и своим статусом расчёта.
-- Тот же принцип, что у точки, маршрута и тура (CLAUDE.md §4.1).
--
-- Идемпотентна.

BEGIN;

CREATE TABLE IF NOT EXISTS eco_compensation_claims (
  id          BIGSERIAL PRIMARY KEY,
  -- Проводка списания, породившая обязательство.
  ledger_id   BIGINT      NOT NULL REFERENCES eco_ledger(id),
  sink        TEXT        NOT NULL,
  eco_amount  BIGINT      NOT NULL,
  -- Рублёвый эквивалент скидки, которую кто-то обязан покрыть.
  rub_amount  NUMERIC(12,2) NOT NULL,
  -- Кто платит В МОМЕНТ списания. После смены фазы старые обязательства
  -- остаются на прежнем плательщике — история не переписывается (Закон 4).
  payer       TEXT        NOT NULL,
  -- Кто именно, когда платит оператор.
  operator_id BIGINT,
  status      TEXT        NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at  TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_claims_amounts_sane') THEN
    ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_amounts_sane
      CHECK (eco_amount > 0 AND rub_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_claims_payer_known') THEN
    ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_payer_known
      CHECK (payer IN ('platform', 'operator'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_claims_status_known') THEN
    ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_status_known
      CHECK (status IN ('pending', 'settled', 'waived'));
  END IF;
  -- Обязательство платит оператор — значит он должен быть назван.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_claims_operator_named') THEN
    ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_operator_named
      CHECK (payer <> 'operator' OR operator_id IS NOT NULL);
  END IF;
END $$;

-- Одно списание — одно обязательство. Повтор вызова ничего не задваивает.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_claims_ledger
  ON eco_compensation_claims (ledger_id);

CREATE INDEX IF NOT EXISTS idx_eco_claims_pending
  ON eco_compensation_claims (payer, created_at DESC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_eco_claims_operator
  ON eco_compensation_claims (operator_id) WHERE operator_id IS NOT NULL;

COMMIT;
