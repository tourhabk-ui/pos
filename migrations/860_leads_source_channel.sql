-- 860: канал происхождения лида (Рост-5 — партнёрский отчёт по лидам).
-- Партнёру продаётся измеримый входящий спрос: у лида должен быть честный
-- ответ «откуда пришёл». Живой словарь и нормализатор — lib/leads/channel.ts
-- (канал пишется при создании лида); здесь только колонка, индекс и
-- одноразовый детерминированный бэкфилл по тем же сигнатурам источников.
-- Непознанное остаётся NULL — отчёт покажет «не атрибуцировано», не догадку.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_channel VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_leads_source_channel
  ON leads (source_channel, created_at DESC);

-- Бэкфилл строго детерминированных случаев (зеркало normalizeLeadChannel).
UPDATE leads SET source_channel = 'mcp'
 WHERE source_channel IS NULL
   AND (source_data->>'source' = 'mcp' OR source_url LIKE 'mcp://%');

UPDATE leads SET source_channel = 'max'
 WHERE source_channel IS NULL
   AND (source_data->>'source' = 'max_bot' OR source_url LIKE '%max.ru%');

UPDATE leads SET source_channel = 'telegram'
 WHERE source_channel IS NULL
   AND (telegram_chat_id IS NOT NULL OR source_url LIKE '%t.me/%');

UPDATE leads SET source_channel = 'widget'
 WHERE source_channel IS NULL AND source_data->>'type' = 'widget';

UPDATE leads SET source_channel = 'site_chat'
 WHERE source_channel IS NULL
   AND (source_data->>'source' = 'booking_intake_bot'
        OR source_url LIKE '%/api/ai/booking-intake%');

UPDATE leads SET source_channel = 'site_route'
 WHERE source_channel IS NULL AND source_url LIKE '%/routes/%';

UPDATE leads SET source_channel = 'site_tour'
 WHERE source_channel IS NULL AND source_url LIKE '%/tours/%';

UPDATE leads SET source_channel = 'site_planner'
 WHERE source_channel IS NULL AND source_url LIKE '%/planner%';

UPDATE leads SET source_channel = 'site'
 WHERE source_channel IS NULL
   AND (source_url LIKE 'http://%' OR source_url LIKE 'https://%' OR source_url LIKE '/%');
