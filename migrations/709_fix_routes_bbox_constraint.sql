-- 709: chk_routes_kamchatka_bbox блокировал Editor — SMOKE WARN «30 обработано, 0 улучшено»
--
-- Причина (видна благодаря error_samples из PR #280): констрейнт появился на
-- проде ВНЕ миграций репозитория (в migrations/ его определения нет). PostgreSQL
-- перепроверяет CHECK на всей строке при ЛЮБОМ UPDATE — маршруты, уже нарушающие
-- констрейнт (кривые координаты у самых сырых записей — ровно очередь Editor'а),
-- не могли получить даже description через VIEW agent_route_knowledge
-- (INSTEAD OF trigger из 677 обновляет строку kamchatka_routes целиком).
--
-- Фикс в три шага: снять неизвестный констрейнт → санировать мусорные координаты
-- (оригинал в metadata для аудита) → добавить NULL-толерантный под контролем кода.
-- Идемпотентно: повторный прогон снимает наш же констрейнт, санирует 0 строк,
-- добавляет заново.

ALTER TABLE kamchatka_routes DROP CONSTRAINT IF EXISTS chk_routes_kamchatka_bbox;

-- Санация: координаты вне bbox Камчатки → NULL (описание/тайтл от координат не
-- зависят; NULL честнее мусора — офлайн-карта и SOS не получат ложную точку).
-- Bbox lat 50..64 / lng 155..170 — объединение границ migration 658 (50-62 /
-- 155-170) и lib/services/geocode.ts KAMCHATKA_BOUNDS (50-64 / 155-167).
UPDATE kamchatka_routes
SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'invalid_coords_backup',
           jsonb_build_object(
             'lat', lat,
             'lng', lng,
             'nulled_at', NOW()::text,
             'reason', 'outside kamchatka bbox (migration 709)'
           )
         ),
    lat = NULL,
    lng = NULL,
    updated_at = NOW()
WHERE lat IS NOT NULL AND lng IS NOT NULL
  AND NOT (lat BETWEEN 50 AND 64 AND lng BETWEEN 155 AND 170);

-- NULL-толерантный bbox-чек: NULL-координаты валидны, явный мусор
-- (Москва, systematic offset lng < 155) не пройдёт при INSERT/UPDATE.
ALTER TABLE kamchatka_routes
  ADD CONSTRAINT chk_routes_kamchatka_bbox
  CHECK (
    lat IS NULL OR lng IS NULL
    OR (lat BETWEEN 50 AND 64 AND lng BETWEEN 155 AND 170)
  );
