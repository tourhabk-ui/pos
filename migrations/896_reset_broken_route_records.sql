-- 896: битые числа записей — в NULL (кампания сверки описаний, «го» 21.08).
--
-- Перепись route-desc-census v3 (проба 127) свела текст каждого живого
-- маршрута с его же записью. У шести запись очевидно врёт, а текст
-- правдоподобен; по правилу третьего состояния враньё не переписывается
-- другой догадкой, а честно сбрасывается в «не знаю»:
--
--   Долина Смерти            distance_km 0.05  — «маршрут» в 50 метров;
--                            текст говорит о 6 км по заповеднику
--   5 стройка–Центральный    distance_km 41    — городская прогулка;
--                            текст: 2.5 км
--   По следам Берингии       distance_km 170   — пешая экскурсия 4-5 часов;
--                            текст: около 8 км
--   Южно-Камчатский: транзитный distance_km 37 — текст: ~120 км на авто
--                            в одну сторону; чья правда — неясно, значит NULL
--   Гора Юрчик               duration_hours 8  — доступная обзорная точка,
--                            текст: подъём 1.5-2 часа
--   Озеро у Высокой горы     duration_hours 1  — 8 км в одну сторону
--                            за час не ходят; текст: 3.5 часа
--
-- Сброс охраняется ТЕКУЩИМ значением: миграция идемпотентна и не тронет
-- запись, которую уже поправили руками.
--
-- Сложность, посчитанная шкалой из битой дистанции (difficulty_source =
-- 'computed_v1'), сбрасывается вместе с ней: счёт от вранья — тоже враньё.
-- Ручную сложность (source NULL) не трогаем.

UPDATE kamchatka_routes
SET distance_km = NULL, updated_at = NOW()
WHERE id::text = '842563f5-c32f-4c5c-9bc1-6248a8f4a8c4'
  AND distance_km IS NOT NULL AND abs(distance_km - 0.05) < 0.001;

UPDATE kamchatka_routes
SET distance_km = NULL, updated_at = NOW()
WHERE id::text = '67fba4be-ac61-46c8-bdf5-225f25b09baa'
  AND distance_km IS NOT NULL AND abs(distance_km - 41) < 0.5;

UPDATE kamchatka_routes
SET distance_km = NULL, updated_at = NOW()
WHERE id::text = 'e2664bb5-5883-4fec-a5cb-0d39c19ffb58'
  AND distance_km IS NOT NULL AND abs(distance_km - 170) < 0.5;

UPDATE kamchatka_routes
SET distance_km = NULL, updated_at = NOW()
WHERE id::text = 'c7e37541-8d6a-4c3c-9cbb-e78f9cc7a304'
  AND distance_km IS NOT NULL AND abs(distance_km - 37) < 0.5;

UPDATE kamchatka_routes
SET duration_hours = NULL, updated_at = NOW()
WHERE id::text = 'fe4a8105-2440-4d66-863c-034f75659e76'
  AND duration_hours IS NOT NULL AND abs(duration_hours - 8) < 0.5;

UPDATE kamchatka_routes
SET duration_hours = NULL, updated_at = NOW()
WHERE id::text = '9307555d-bcfd-4073-95ba-b149deb709df'
  AND duration_hours IS NOT NULL AND abs(duration_hours - 1) < 0.5;

-- Сложность, выведенная из сброшенной дистанции.
UPDATE kamchatka_routes
SET difficulty = NULL, difficulty_source = NULL, updated_at = NOW()
WHERE id::text IN (
    '842563f5-c32f-4c5c-9bc1-6248a8f4a8c4',
    '67fba4be-ac61-46c8-bdf5-225f25b09baa',
    'e2664bb5-5883-4fec-a5cb-0d39c19ffb58',
    'c7e37541-8d6a-4c3c-9cbb-e78f9cc7a304'
  )
  AND difficulty_source = 'computed_v1'
  AND distance_km IS NULL;
