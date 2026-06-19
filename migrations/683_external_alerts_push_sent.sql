-- Push-дедупликация: фиксируем когда push-рассылка была отправлена для алерта.
-- Если push_sent_at IS NULL и severity >= 2 → алерт ещё не разослан.
-- Если push_sent_at IS NOT NULL → рассылка уже прошла, повтор не нужен.
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMPTZ;
