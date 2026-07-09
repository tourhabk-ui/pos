-- Migration 727: атрибуция брони агентской реф-ссылке
--
-- Скаффолд реферальной программы (миграция 055: agent_referral_links +
-- agent_referral_events) был наполовину мёртв: клики считались, но конверсии
-- нигде не писались, а у operator_bookings не было колонки атрибуции — бронь
-- нельзя было связать с реф-ссылкой агента. Добавляем источник истины:
-- operator_bookings.referral_link_id. Заработок агента считается из него.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS referral_link_id UUID REFERENCES agent_referral_links(id);

CREATE INDEX IF NOT EXISTS idx_operator_bookings_referral
  ON operator_bookings (referral_link_id)
  WHERE referral_link_id IS NOT NULL;

COMMIT;
