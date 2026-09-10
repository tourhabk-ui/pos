-- 946: каталог моделей с ценами, привезённый на прод
--
-- Прод НЕ ВИДИТ каталог OpenRouter: 403 и напрямую, и через релей (замер
-- 07.09). Поэтому «актуальные цены в админке» — это не «прод спросил», а
-- «раннер принёс»: то же разделение труда, что у editor-runner, где список
-- выбирает прод, а наружу ходит раннер GitHub.
--
-- Цена NULL — не ноль. Каталог может не назвать цену вовсе, и превратить это
-- в «бесплатно» значило бы соврать в ту сторону, где ошибка дороже всего
-- (§4.0). Ноль ставится только когда каталог сам сказал ноль — у бесплатных
-- моделей это правда.
--
-- last_seen_at отличает «цена такая» от «модель пропала из каталога»: строка
-- со старым last_seen_at остаётся видна, но помечена как выбывшая, а не выдаёт
-- вчерашнюю цену за сегодняшнюю.
CREATE TABLE IF NOT EXISTS model_catalog (
  model_id          TEXT PRIMARY KEY,
  vendor            TEXT NOT NULL,
  display_name      TEXT,
  usd_per_mtok_in   NUMERIC,
  usd_per_mtok_out  NUMERIC,
  context_length    INTEGER,
  source            TEXT NOT NULL DEFAULT 'openrouter',
  last_seen_at      TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_vendor ON model_catalog(vendor);
CREATE INDEX IF NOT EXISTS idx_model_catalog_last_seen ON model_catalog(last_seen_at DESC);

COMMENT ON COLUMN model_catalog.usd_per_mtok_in IS
  'Цена входа, $ за миллион токенов. NULL — каталог цену не назвал; 0 — назвал ноль.';
COMMENT ON COLUMN model_catalog.last_seen_at IS
  'Когда модель последний раз встретилась в каталоге. Отстал от последней партии — модель выбыла.';
