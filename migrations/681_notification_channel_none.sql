-- Migration 681: расширить допустимые каналы в route_registration_notifications
-- Добавляем 'none' (шаг записан как skipped без реального канала)

ALTER TABLE route_registration_notifications
  DROP CONSTRAINT IF EXISTS route_registration_notifications_channel_check;

ALTER TABLE route_registration_notifications
  ADD CONSTRAINT route_registration_notifications_channel_check
  CHECK (channel IN ('telegram', 'email', 'max', 'none'));
