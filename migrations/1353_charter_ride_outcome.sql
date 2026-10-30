-- Migration 1353: «Поездка состоялась» от перевозчика — доказательство отзыва нового рода
-- Created: 2026-10-30
--
-- #2862 этап B (слово владельца 30.10 «нужно тоже продумать CRM полное с ТГ
-- и MAX и закрыть дыры»). До этого дня подтвердить поездку по заявке на
-- машину мог только менеджер Ведара (1235): у перевозчика кабинета не было,
-- и отзыв без менеджера был невозможен. Теперь перевозчик, ответивший на
-- заявку «Беру», на следующий день после поездки отвечает «Поездка
-- состоялась» / «Не состоялась» — кнопкой в MAX, в карточке кабинета в чате
-- и во «Входящих» на сайте.
--
-- CLAUDE.md §14 называл это прямо: кнопка в кабинете перевозчика появится
-- вместе с доказательством НОВОГО рода, а не переиспользует «подтвердил
-- менеджер». Отсюда:
--
--   · carrier_reviews.proof — третье значение 'charter_carrier': под отзывом
--     читатель увидит «поездку подтвердил перевозчик», не «менеджер Ведара»;
--   · carrier_review_invites знает, КТО подтвердил: confirmed_by_kind
--     ('manager' — как было, 'carrier') и карточка перевозчика
--     (confirmed_partner_id). Прежние строки — 'manager' по умолчанию;
--   · исход поездки — одна запись на заявку в журнале лида
--     (lead_activity_log, action 'ride_outcome'), как ответ «Беру» / «Не
--     могу» (1326): второе нажатие не пишет второй исход;
--   · вопрос «Поездка состоялась?» ждёт ответа во «Входящих» перевозчика
--     (вид charter_ride) и через два часа идёт в напоминание — CHECK таблицы
--     напоминаний перечисляет виды поимённо (1201, 1352).
--
-- Идемпотентно.

BEGIN;

-- 1235 завела proof как VARCHAR(10): 'charter_carrier' в десять знаков не
-- входит — без расширения вставка падала бы на 22001 при зелёном CHECK
-- (поймано прогоном на настоящем PostgreSQL, не глазами).
ALTER TABLE carrier_reviews ALTER COLUMN proof TYPE VARCHAR(20);
ALTER TABLE carrier_reviews DROP CONSTRAINT IF EXISTS carrier_reviews_proof_check;
ALTER TABLE carrier_reviews ADD CONSTRAINT carrier_reviews_proof_check
  CHECK (proof IN ('seat', 'charter', 'charter_carrier'));

ALTER TABLE carrier_review_invites
  ADD COLUMN IF NOT EXISTS confirmed_by_kind TEXT NOT NULL DEFAULT 'manager',
  ADD COLUMN IF NOT EXISTS confirmed_partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

ALTER TABLE carrier_review_invites DROP CONSTRAINT IF EXISTS carrier_review_invites_confirmed_by_kind_check;
ALTER TABLE carrier_review_invites ADD CONSTRAINT carrier_review_invites_confirmed_by_kind_check
  CHECK (confirmed_by_kind IN ('manager', 'carrier'));

COMMENT ON COLUMN carrier_review_invites.confirmed_by_kind IS
  'Кто подтвердил, что поездка состоялась: manager — менеджер Ведара (1235), carrier — сам перевозчик кнопкой (1353). Род доказательства отзыва берётся отсюда.';

-- Исход поездки от перевозчика — один на заявку.
CREATE UNIQUE INDEX IF NOT EXISTS lead_activity_log_ride_outcome_uidx
  ON lead_activity_log (lead_id)
  WHERE action = 'ride_outcome';

ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite',
  'charter_request', 'charter_ride'
));

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE crm_inbox_reminders DROP CONSTRAINT IF EXISTS crm_inbox_reminders_kind_check;
-- ALTER TABLE crm_inbox_reminders ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
--   'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite', 'charter_request'
-- ));
-- DROP INDEX IF EXISTS lead_activity_log_ride_outcome_uidx;
-- ALTER TABLE carrier_review_invites DROP CONSTRAINT IF EXISTS carrier_review_invites_confirmed_by_kind_check;
-- ALTER TABLE carrier_review_invites DROP COLUMN IF EXISTS confirmed_partner_id, DROP COLUMN IF EXISTS confirmed_by_kind;
-- -- Отзывы рода charter_carrier перед откатом CHECK пришлось бы перевести или снять.
-- ALTER TABLE carrier_reviews DROP CONSTRAINT IF EXISTS carrier_reviews_proof_check;
-- ALTER TABLE carrier_reviews ADD CONSTRAINT carrier_reviews_proof_check CHECK (proof IN ('seat', 'charter'));
-- ALTER TABLE carrier_reviews ALTER COLUMN proof TYPE VARCHAR(10);
-- COMMIT;
