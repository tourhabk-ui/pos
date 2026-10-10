-- Migration 1213: заявка на жильё помнит, откуда пришла и куда дошла
-- Created: 2026-10-10
--
-- Повод — тестовая заявка владельца в «Кутху» 10.10 через Claude: ему в
-- Telegram пришла заглушка без имени и телефона, а в админке заявки не было
-- вовсе. stay_requests (1206) писали форма и MCP, но не читал ни один экран
-- (объявленный исход без потребителя, §10.09), и куда ушло сообщение, не
-- сохранялось: ответить на «а хозяину дошло?» было нечем, кроме логов.
--
-- Колонки — с производителем и потребителем в этом же PR:
--   * door — какой дверью пришла заявка: form (форма на карточке) или mcp
--     (ассистент через create_stay_request). Пишет submitStayRequest во
--     вставке; NULL — заявка до 1213, дверь не записана;
--   * owner_channel / owner_reason — что стало с сообщением хозяину:
--     max (дошло с именем и телефоном), telegram-stub (только заглушка без
--     них), none (не дошло никуда), no_address (хозяин не подключён к боту —
--     слать было некуда). Причина — словами из sendPdAlert;
--   * platform_channel / platform_reason — то же для рабочего чата
--     платформы: max / telegram-stub / none;
--   * delivery_recorded_at — когда исход записан. NULL — заявка до 1213 или
--     запись исхода не удалась (отказ логируется с SQLSTATE): «не записано»
--     не равно «не дошло» (§4.0).
-- Читает всё это вкладка «Заявки гостей» в /hub/admin/accommodations
-- (GET /api/admin/stay-requests).
--
-- Согласие на ПД (1206) этими колонками не затрагивается: оно пишется только
-- во вставке, исход — отдельным UPDATE после отправки.

BEGIN;

ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS door TEXT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS owner_channel TEXT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS owner_reason TEXT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS platform_channel TEXT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS platform_reason TEXT;
ALTER TABLE stay_requests ADD COLUMN IF NOT EXISTS delivery_recorded_at TIMESTAMPTZ;

ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_door_check;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_door_check
  CHECK (door IS NULL OR door IN ('form', 'mcp'));

ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_channel_check;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_owner_channel_check
  CHECK (owner_channel IS NULL OR owner_channel IN ('max', 'telegram-stub', 'none', 'no_address'));

ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_platform_channel_check;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_platform_channel_check
  CHECK (platform_channel IS NULL OR platform_channel IN ('max', 'telegram-stub', 'none'));

-- Исход пишется целиком: отметка времени без обоих каналов (или каналы без
-- отметки) — непонятно, что из этого правда.
ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_delivery_complete;
ALTER TABLE stay_requests ADD CONSTRAINT stay_requests_delivery_complete
  CHECK (
    (delivery_recorded_at IS NULL AND owner_channel IS NULL AND platform_channel IS NULL)
    OR (delivery_recorded_at IS NOT NULL AND owner_channel IS NOT NULL AND platform_channel IS NOT NULL)
  );

COMMENT ON COLUMN stay_requests.door IS 'form — форма на карточке, mcp — ассистент (create_stay_request). NULL — до 1213, не записано.';
COMMENT ON COLUMN stay_requests.owner_channel IS 'Сообщение хозяину: max / telegram-stub (без ПД) / none / no_address (не подключён к боту).';
COMMENT ON COLUMN stay_requests.platform_channel IS 'Копия в рабочий чат платформы: max / telegram-stub (без ПД) / none.';
COMMENT ON COLUMN stay_requests.delivery_recorded_at IS 'Когда записан исход доставки. NULL — до 1213 или запись не удалась: не записано, а не «не дошло».';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_delivery_complete;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_platform_channel_check;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_owner_channel_check;
-- ALTER TABLE stay_requests DROP CONSTRAINT IF EXISTS stay_requests_door_check;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS delivery_recorded_at;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS platform_reason;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS platform_channel;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS owner_reason;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS owner_channel;
-- ALTER TABLE stay_requests DROP COLUMN IF EXISTS door;
-- COMMIT;
