-- 1327: черновик правки цены или описания машины проката.
--
-- Живая строка car_rental_offers остаётся на сайте как есть. Прокатчик в MAX
-- пишет новую цену или описание — сюда ложится черновик со статусом pending.
-- На сайт числа и текст попадают только когда администратор одобрит черновик
-- в /hub/admin/moderation: код тогда переписывает колонки живой строки.
-- Отклонение живую строку не трогает. Фото этой таблицей не меняются.
-- Один pending на машину: вторая правка того же поля заменяет черновик,
-- соседнее поле (цена или описание), уже лежащее в том же черновике, сохраняется.

BEGIN;

CREATE TABLE IF NOT EXISTS rental_offer_edits (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  offer_id          UUID NOT NULL REFERENCES car_rental_offers(id) ON DELETE CASCADE,
  partner_id        UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL — это поле черновик не меняет. Ноль и пустая строка не пишутся:
  -- это не цена и не описание.
  price_rub_per_day INTEGER CHECK (price_rub_per_day IS NULL OR price_rub_per_day > 0),
  conditions        TEXT CHECK (conditions IS NULL OR length(btrim(conditions)) > 0),
  moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  moderation_reason TEXT,
  moderated_at      TIMESTAMPTZ,
  moderated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rental_offer_edits_has_change CHECK (
    price_rub_per_day IS NOT NULL OR conditions IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rental_offer_edits_one_pending
  ON rental_offer_edits (offer_id)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS rental_offer_edits_pending_created
  ON rental_offer_edits (created_at)
  WHERE moderation_status = 'pending';

COMMENT ON TABLE rental_offer_edits IS
  'Черновик цены или описания машины проката (1327). На сайте его нет: живая строка меняется только после approved';
COMMENT ON COLUMN rental_offer_edits.conditions IS
  'Новое описание строки прайса (car_rental_offers.conditions). NULL — описание черновик не меняет';
COMMENT ON COLUMN rental_offer_edits.price_rub_per_day IS
  'Новая цена за сутки, ₽. NULL — цену черновик не меняет. Пометку «от» черновик не снимает';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS rental_offer_edits;
-- COMMIT;
