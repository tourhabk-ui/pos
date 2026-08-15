-- 870: Брифинг похода — временная ссылка для контакта вне маршрута
--      (Field Confidence Navigator, этап 5).
--
-- Зачем: план не должен жить в одном телефоне. Кто-то вне маршрута обязан
-- знать, куда человек ушёл и когда его ждать обратно — это первое, что
-- спросят спасатели. Ссылка отдаёт ПЛАН, а не положение.
--
-- Чего здесь СОЗНАТЕЛЬНО нет:
--   * координат и любой live-локации — телефонная PWA не спутниковый маяк,
--     обещать слежение мы не вправе; брифинг говорит о плане и времени;
--   * контактных данных получателя (телефон/почта/имя) — мы не собираем
--     чужие ПД ради ссылки: человек отправляет её сам своим мессенджером.
--     Это снимает трансграничную передачу ПД (152-ФЗ) на пустом месте.
--
-- expires_at NOT NULL: ссылка без срока — это не «поделиться», а публикация.
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS trip_preparation_shares (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       UUID NOT NULL DEFAULT gen_random_uuid(),
  plan_id     UUID NOT NULL REFERENCES trip_preparation_plans(id) ON DELETE CASCADE,
  -- Что видит получатель. Снимок, а не ссылка на живые данные: состояние
  -- полевого пакета известно только устройству туриста, и позже его уже
  -- неоткуда взять. Возраст снимка виден на странице.
  snapshot    JSONB NOT NULL,
  -- Область видимости. Сейчас единственная — 'briefing' (план и время).
  -- Отдельное поле, чтобы 'live_location' нельзя было включить молча:
  -- для него нужен и код, и решение владельца.
  scope       VARCHAR(20) NOT NULL DEFAULT 'briefing',
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_prep_share_scope CHECK (scope IN ('briefing'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_prep_shares_token
  ON trip_preparation_shares(token);

CREATE INDEX IF NOT EXISTS idx_trip_prep_shares_plan
  ON trip_preparation_shares(plan_id);
