-- 1469: статус «открыт / закрыт» утверждённых маршрутов природных парков
-- (слово владельца 20.11: «Статус открыт/закрыт», шкала цветов — «Шкала как
-- у KVERT»).
--
-- Статус пишет только чтение страницы парка «Туристические маршруты»
-- (GET /api/cron/park-route-status, раз в сутки): что парк написал в колонке
-- «Статус» у варианта маршрута, то и записано, с временем чтения. Миграция
-- статус не заполняет: прочитанное 20.11 к утру уже было бы не тем, что
-- парк пишет сейчас.
--
-- NULL в status — страница ещё не прочитана. Статус старше трёх суток читатели
-- считают «не проверено» (lib/parks/park-route-status, PARK_STATUS_FRESH_HOURS):
-- чтение могло перестать работать, а запись осталась бы стоять.
--
-- Идемпотентна: повтор ничего не меняет.

ALTER TABLE park_approved_routes
  ADD COLUMN IF NOT EXISTS status VARCHAR(8) CHECK (status IN ('open', 'closed')),
  ADD COLUMN IF NOT EXISTS status_read_at TIMESTAMPTZ;

COMMENT ON COLUMN park_approved_routes.status IS
  'Статус варианта по колонке «Статус» страницы парка: open / closed; NULL — не прочитан.';
COMMENT ON COLUMN park_approved_routes.status_read_at IS
  'Когда статус прочитан со страницы парка; старше трёх суток — «не проверено».';
