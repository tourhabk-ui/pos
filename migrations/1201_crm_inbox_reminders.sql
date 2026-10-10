-- Migration 1201: напоминание партнёру о входящем без ответа (CRM #2325, шаг 1г-2)
-- Created: 2026-10-10
--
-- ── Зачем ─────────────────────────────────────────────────────────────────
-- «Входящие» (1г-1) вычисляются из источников: бронь в статусе «новая» —
-- уже входящее, своей таблицы у ящика нет. Напоминанию же нужна память:
-- о чём уже напомнили и куда, иначе крон каждые полчаса слал бы одно и то же.
--
-- Ступень одна — 2 часа в дневное время Камчатки (урок Tripster: заказы
-- получает тот, кто ответил за два часа). Ступени «24 часа» нет намеренно:
-- через 24 часа партнёру о брони жилья, проката и мест в машине уже пишет
-- Watchdog (через 48 — о брони тура). Вторая дверь одного и того же
-- сообщения — дубль, на который партнёр перестанет смотреть.
--
-- ── Исходы (§4.0) ─────────────────────────────────────────────────────────
-- channel: max — доставлено с подробностями; telegram_stub — ушла заглушка
-- без ПД; unreachable — слать некуда (ни MAX, ни Telegram). Отказ доставки
-- строки не пишет: следующий прогон пробует снова.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_inbox_reminders (
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  item_kind   TEXT        NOT NULL,
  item_id     TEXT        NOT NULL,
  channel     TEXT        NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partner_id, item_kind, item_id),
  CONSTRAINT crm_inbox_reminders_kind_check CHECK (item_kind IN (
    'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite'
  )),
  CONSTRAINT crm_inbox_reminders_channel_check CHECK (channel IN ('max', 'telegram_stub', 'unreachable'))
);

COMMENT ON TABLE crm_inbox_reminders IS
  'Напоминание партнёру о входящем без ответа 2 часа (CRM 1г-2, #2325): одно на предмет. Отказ доставки строки не пишет.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS crm_inbox_reminders;
-- COMMIT;
