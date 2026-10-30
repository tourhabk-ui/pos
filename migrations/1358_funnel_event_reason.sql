-- Migration 1358: причина и источник у события воронки (#2882, слово владельца 30.10 «бери логирование»)
-- Created: 2026-10-30
--
-- До этого дня воронка брони знала один шаг — касание формы (`booking_start`,
-- маяк из браузера). Отправка заявки и отказ (нет мест, дата закрыта, вне
-- сезона, цена не названа, дата в прошлом, форма не прошла проверку) уходили
-- туристу в ответ и в консоль — и нигде не оставались. При «Бронирований: 0»
-- нельзя было сказать, где рвётся: никто не доходит до формы, или доходит и
-- получает отказ, и какой.
--
-- Два новых шага пишет СЕРВЕР (lib/funnel/record.ts), не маяк: `booking_submitted`
-- и `booking_rejected`. У отказа есть `reason` — код из словаря
-- lib/funnel/steps.ts (BOOKING_REJECT_REASONS), не свободный текст. `source` —
-- канал брони (`created_via`: website, kuzmich, agent …). Колонки nullable:
-- у шагов маяка причины и источника нет.
--
-- ПД здесь нет: коды, канал, id тура и тот же суточный visitor_hash.

BEGIN;

ALTER TABLE funnel_events
  ADD COLUMN IF NOT EXISTS reason VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source VARCHAR(40);

COMMENT ON COLUMN funnel_events.reason IS 'Код причины у booking_rejected (lib/funnel/steps.ts BOOKING_REJECT_REASONS); у прочих шагов NULL';
COMMENT ON COLUMN funnel_events.source IS 'Канал серверного шага: created_via брони (website, kuzmich, agent …); у шагов маяка NULL';

CREATE INDEX IF NOT EXISTS idx_funnel_events_step_reason
  ON funnel_events (step, reason, created_at DESC)
  WHERE reason IS NOT NULL;

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_funnel_events_step_reason;
-- ALTER TABLE funnel_events DROP COLUMN IF EXISTS reason, DROP COLUMN IF EXISTS source;
-- COMMIT;
