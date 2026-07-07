-- Migration 718: июльские дорожные ограничения (Вилючинский перевал, Вачкажец)
--
-- Новость от подрядчика (ustoym.ru) не была поймана автоматически: категория
-- road_closure появилась только сейчас, а kamgov/minec-источники ещё не
-- подключены к конвейеру алертов. Заводим оба ограничения руками, чтобы
-- туристы увидели их в мобильном баннере, карточках точек и у Кузьмича
-- до начала действия (15 и 20 июля).
--
-- 1) Вилючинский перевал: с 15.07 проезд от Термального строго по пропускам,
--    окна 07:00-08:00 / 13:00-14:00 / 19:00-20:00 (строительство дороги).
--    Срок окончания НЕ объявлен -> expires_at 2027-01-01, гасится админом
--    через DELETE /api/admin/external-alerts/[id] по факту снятия режима.
-- 2) Вачкажец: проезд закрыт с 08:00 20.07 до 18:00 27.07 (камчатское время,
--    UTC+12). Объезд через поля со стороны пос. Сокоч (до моста через
--    р. Плотникова). Алерт истекает сам в момент открытия дороги.
--    Колонки TIMESTAMP без tz, сравнение идёт с NOW() в UTC -> камчатское
--    18:00 27.07 записано как 06:00 UTC.
--
-- Идемпотентна: дедуп по external_id (ON CONFLICT DO NOTHING).

BEGIN;

INSERT INTO external_alerts (
  alert_type, severity, title, description,
  affected_zones, created_at, expires_at, source_url, external_id
) VALUES (
  'road_closure',
  1,
  'Вилючинский перевал: проезд по пропускам с 15 июля',
  'С 15 июля проезд от Термального к Вилючинскому перевалу и прилегающим территориям — строго по пропускам (активная фаза строительства дороги). Окна проезда: 07:00-08:00, 13:00-14:00, 19:00-20:00. Документы для оформления пропуска — на сайте подрядчика www.ustoym.ru. Срок окончания режима не объявлен — алерт гасится вручную по факту снятия ограничений.',
  ARRAY['avachinsky'],
  NOW(),
  '2027-01-01 00:00:00',
  'https://www.ustoym.ru',
  'manual-vilyuchinsky-pass-2026-07'
)
ON CONFLICT (external_id) DO NOTHING;

INSERT INTO external_alerts (
  alert_type, severity, title, description,
  affected_zones, created_at, expires_at, source_url, external_id
) VALUES (
  'road_closure',
  2,
  'Вачкажец: проезд закрыт 20-27 июля',
  'С 08:00 20 июля до 18:00 27 июля закрыт проезд к горному массиву Вачкажец по привычному турмаршруту. Объезд — через поля со стороны посёлка Сокоч (до моста через реку Плотникова).',
  ARRAY['western', 'avachinsky'],
  NOW(),
  '2026-07-27 06:00:00',
  NULL,
  'manual-vachkazhets-road-2026-07'
)
ON CONFLICT (external_id) DO NOTHING;

-- Точечные сообщения на карточках самих мест (alert_message читает
-- /api/places/[id] -> realtime.alertMessage). is_open не трогаем:
-- места открыты, ограничен именно проезд.
UPDATE location_real_time_status lrts
SET alert_message    = 'Проезд от Термального — по пропускам с 15 июля: окна 07:00-08:00, 13:00-14:00, 19:00-20:00. Пропуск: www.ustoym.ru',
    alert_source     = 'manual',
    alert_expires_at = '2027-01-01 00:00:00',
    updated_at       = NOW()
FROM places p
WHERE p.ark_id = lrts.agent_route_id
  AND p.name ILIKE '%вилючинск%перевал%';

UPDATE location_real_time_status lrts
SET alert_message    = 'Проезд закрыт с 08:00 20.07 до 18:00 27.07. Объезд через поля от пос. Сокоч (до моста через р. Плотникова)',
    alert_source     = 'manual',
    alert_expires_at = '2026-07-27 06:00:00',
    updated_at       = NOW()
FROM places p
WHERE p.ark_id = lrts.agent_route_id
  AND p.name ILIKE '%вачкажец%';

COMMIT;
