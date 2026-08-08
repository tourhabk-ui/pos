-- 839: события воронки (Эволюция 3.0, п.5 — владелец 08.08: «действуй»).
--
-- Контекст решения: у платформы 650 API-роутов и 37 кронов, а живых
-- партнёров два и пользователей ноль. Петля эволюции видела ошибки кода
-- (onRequestError → scanProdErrors), но не видела ГЛАВНОГО: доходит ли
-- кто-то до каталога, открывает ли тур, начинает ли бронь. Низ воронки
-- уже лежит в БД (leads, operator_bookings, paid_at) — не хватало верха.
--
-- Сюда пишет ТОЛЬКО публичный маяк POST /api/funnel (шаги catalog_view /
-- tour_view / booking_start). visitor_hash — усечённый sha256(сутки+ip+ua):
-- сырой IP не храним (152-ФЗ), суточная соль не даёт склеивать дни.
-- Ретенция 90 суток — чистит объектив scanFunnel при ночном прогоне.

CREATE TABLE IF NOT EXISTS funnel_events (
  id           BIGSERIAL PRIMARY KEY,
  step         VARCHAR(40) NOT NULL,        -- catalog_view | tour_view | booking_start
  entity_id    TEXT,                        -- id тура для tour_view / booking_start
  visitor_hash VARCHAR(64),                 -- анонимный суточный хэш, не PII
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_step_time ON funnel_events(step, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_time ON funnel_events(created_at);
