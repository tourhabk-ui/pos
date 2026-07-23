-- Здоровье источников safety-ingest: чтобы молчащий канал (напр. MAX-SPA без
-- данных или VK без токена) не падал МОЛЧА. На каждом прогоне cron пишем сюда
-- статус источника; сторож находит «мёртвые» (не настроен / давно ничего не даёт)
-- и шлёт разовый алерт в Telegram. Владелец увидел это на живом случае: пост МЧС
-- про пеплопад Шивелуча (24.07) не долетел в ленту, т.к. MAX-скрейп пуст.
CREATE TABLE IF NOT EXISTS safety_source_health (
  source_key        TEXT PRIMARY KEY,       -- vk_mchs / max_mchs / mchs_rss / kbgsras / ...
  label             TEXT,
  last_run_at       TIMESTAMPTZ,            -- когда источник в последний раз опрашивался
  last_status       TEXT,                   -- ok | empty | not_configured | not_fetched | error
  raw_items         INT DEFAULT 0,          -- сколько релевантных постов дал последний прогон
  inserted          INT DEFAULT 0,          -- сколько реально вставлено в external_alerts
  last_nonempty_at  TIMESTAMPTZ,            -- когда источник в последний раз дал хоть один пост
  last_alerted_at   TIMESTAMPTZ,            -- дебаунс алерта
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
