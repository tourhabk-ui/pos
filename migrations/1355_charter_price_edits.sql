-- Migration 1355: черновик правки прайса перевозчика — из кабинета, с модерацией
-- Created: 2026-10-30
--
-- #2862 этап C (слово владельца 30.10 «нужно тоже продумать CRM полное с ТГ
-- и MAX и закрыть дыры»). До этого дня прайс перевозчика
-- (transfer_charter_prices) правился только миграциями — четыре за октябрь,
-- каждая рукой разработчика. У проката тот же вопрос решён 1327: правка
-- ложится черновиком, живая строка меняется только одобрением администратора
-- в /hub/admin/moderation. Здесь то же правило для перевозчика.
--
-- Два рода черновика в одной таблице:
--   · правка СУЩЕСТВУЮЩЕЙ строки (price_id записан): цена, примечание,
--     условия, показывать ли на сайте. NULL в поле — «черновик это поле не
--     меняет»; направление и вид машины черновиком не меняются (это другая
--     строка — её заводят новой, а старую скрывают);
--   · НОВАЯ строка (price_id пуст): вид машины, род строки, направление и
--     цена обязательны и подчиняются той же форме, что у живой таблицы
--     (line_shape из 1185/1292); одобрение вставляет строку в прайс.
--
-- Один pending на живую строку: вторая правка той же строки дополняет
-- черновик (COALESCE в коде), соседнее поле сохраняется. Новых строк
-- pending может быть несколько — у них нет общего ключа до одобрения.
-- Что одобряется — то, что видел модератор: сверка полей в коде
-- (lib/transfers/price-edit-store.ts), как у проката.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS transfer_charter_price_edits (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id        UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL — черновик новой строки прайса.
  price_id          UUID REFERENCES transfer_charter_prices(id) ON DELETE CASCADE,
  -- Только у новой строки: у правки существующей — NULL (направление и вид не правятся).
  vehicle_kind      VARCHAR(20) CHECK (vehicle_kind IS NULL OR vehicle_kind IN ('jeep', 'vahtovka', 'minibus', 'other')),
  line_kind         VARCHAR(12) CHECK (line_kind IS NULL OR line_kind IN ('destination', 'extra_day', 'per_hour', 'per_day')),
  from_text         VARCHAR(255) CHECK (from_text IS NULL OR length(btrim(from_text)) > 0),
  to_text           VARCHAR(255) CHECK (to_text IS NULL OR length(btrim(to_text)) > 0),
  -- NULL — поле черновик не меняет. Ноль и пустая строка не пишутся.
  price_rub         INTEGER CHECK (price_rub IS NULL OR price_rub > 0),
  price_note        VARCHAR(255) CHECK (price_note IS NULL OR length(btrim(price_note)) > 0),
  conditions        TEXT CHECK (conditions IS NULL OR length(btrim(conditions)) > 0),
  valid_year        INTEGER CHECK (valid_year IS NULL OR valid_year BETWEEN 2020 AND 2100),
  is_active         BOOLEAN,
  moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  moderation_reason TEXT,
  moderated_at      TIMESTAMPTZ,
  moderated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Правка существующей строки: хоть одно поле меняется, направление и вид не трогаются.
  CONSTRAINT transfer_charter_price_edits_edit_shape CHECK (
    price_id IS NULL OR (
      vehicle_kind IS NULL AND line_kind IS NULL AND from_text IS NULL AND to_text IS NULL AND valid_year IS NULL
      AND (price_rub IS NOT NULL OR price_note IS NOT NULL OR conditions IS NOT NULL OR is_active IS NOT NULL)
    )
  ),
  -- Новая строка: та же форма, что у живого прайса (1185, 1292).
  CONSTRAINT transfer_charter_price_edits_new_shape CHECK (
    price_id IS NOT NULL OR (
      vehicle_kind IS NOT NULL AND line_kind IS NOT NULL AND price_rub IS NOT NULL AND is_active IS NULL
      AND (
        (line_kind = 'destination' AND from_text IS NOT NULL AND to_text IS NOT NULL)
        OR (line_kind IN ('extra_day', 'per_hour', 'per_day') AND from_text IS NULL AND to_text IS NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS transfer_charter_price_edits_one_pending
  ON transfer_charter_price_edits (price_id)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS transfer_charter_price_edits_pending_created
  ON transfer_charter_price_edits (created_at)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS transfer_charter_price_edits_partner
  ON transfer_charter_price_edits (partner_id, created_at DESC);

COMMENT ON TABLE transfer_charter_price_edits IS
  'Черновик правки или новой строки прайса перевозчика (1355). На сайте его нет: transfer_charter_prices меняется только после approved';
COMMENT ON COLUMN transfer_charter_price_edits.price_id IS
  'Строка прайса, которую правит черновик; NULL — черновик новой строки';
COMMENT ON COLUMN transfer_charter_price_edits.is_active IS
  'Показывать ли строку на сайте после одобрения; NULL — черновик это не меняет (у новой строки всегда NULL: она выходит на сайт одобрением)';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS transfer_charter_price_edits;
-- COMMIT;
