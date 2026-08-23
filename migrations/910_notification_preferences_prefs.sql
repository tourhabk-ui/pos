-- Migration 910: настройки уведомлений перестают жить в памяти процесса.
--
-- ФАКТ. lib/services/operators/notification.service.ts держал настройки в
-- `new Map<string, ...>()` на уровне модуля. Это значит: настройки терялись
-- при каждом перезапуске и каждом выкате, а на нескольких экземплярах
-- приложения один и тот же пользователь получал бы разные ответы в
-- зависимости от того, какой процесс его обслужил. Пользователь при этом
-- видел успех: PUT возвращал сохранённый объект, GET после рестарта —
-- умолчания, и отличить «я так настроил» от «мы это потеряли» было нельзя.
-- Находка Growth Scan, подтверждена судьёй 23.08 (единственная «по делу»
-- из сорока пяти).
--
-- ПОЧЕМУ НОВАЯ КОЛОНКА, А НЕ НОВАЯ ТАБЛИЦА. Таблица notification_preferences
-- уже есть в baseline, с первичным ключом по user_id. Но её колонки — булевы
-- флаги (email_enabled, new_booking, marketing...), а сервис и его эндпоинт
-- /api/engagement/notifications/preferences работают с другой формой:
-- quietHours, channelPreferences, typePreferences, frequencyLimit,
-- unsubscribeAll. Раскладывать это по колонкам нечестно — quietHours и
-- frequencyLimit не булевы и колонки под них пришлось бы выдумывать.
-- Поэтому форма сервиса кладётся в JSONB рядом, а существующие флаги
-- остаются нетронутыми: их читает другой код, и ломать его незачем.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN notification_preferences.prefs IS
  'Настройки в форме API /api/engagement/notifications/preferences: quietHours, channelPreferences, typePreferences, frequencyLimit, unsubscribeAll. Булевы колонки этой таблицы — отдельный, более старый набор флагов.';
