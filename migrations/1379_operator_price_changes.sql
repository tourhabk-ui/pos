-- 1379: изменение цен, ожидающее подтверждения на сайте (K.ai B3).
-- Решение владельца 03.11.2026: ссылка живёт 24 часа, одноразовая, изменение
-- хранится на сервере, подтверждает вошедший на сайт с правом цен.
-- Кузьмич только создаёт строку; цены меняет подтверждение.
CREATE TABLE IF NOT EXISTS operator_price_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid NOT NULL,
  change       jsonb NOT NULL,
  preview      jsonb NOT NULL,
  source       varchar(20) NOT NULL DEFAULT 'chat',
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  confirmed_by uuid,
  CONSTRAINT operator_price_changes_ttl CHECK (expires_at <= created_at + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS operator_price_changes_operator_idx ON operator_price_changes (operator_id, created_at DESC);
