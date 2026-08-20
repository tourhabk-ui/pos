-- 887: слитая запись не бывает на витрине (инвариант мягкого слияния).
--
-- ИСТОРИЯ ДЕФЕКТА (вскрыт пробой 109). «Голубые озёра на Камчатке!» и
-- «Поход вокруг Толбачиков. Камчатка» были честно слиты актуатором семей
-- ещё 15.08 (скрытые, merged_into_id на выживших). Позже restore в
-- route-twins-hide вернул им is_visible = true, НЕ глядя на слитость, —
-- получилось состояние «видимая, но слитая», которого не видит никто:
--   - поиск (/api/routes/search) фильтровал только is_visible → показывал их;
--   - аудит считает живыми is_visible AND merged IS NULL → не считал их;
--   - миграции 885/886 сливали с guard merged_into_id IS NULL → пропускали их.
-- Каждый смотрел в свою половину инварианта, и запись жила в щели между ними.
--
-- Что делает миграция:
--   1) выпрямляет цепочки слияний (a1aa4197 → 9a45a836 → f7d4acc0 становится
--      a1aa4197 → f7d4acc0): цель слияния обязана быть живой записью,
--      иначе карточка-редирект вела бы на скрытую;
--   2) гасит видимость у всех слитых — маршруты и места одним правилом.
--
-- Кодовая половина починки — тем же коммитом: restore проверяет слитость,
-- актуатор гасит видимость сам, поиск фильтрует merged_into_id.
-- Сторож: tests/unit/soft-merge-liveness.test.ts.
--
-- Идемпотентно: все UPDATE сужены условием на текущее кривое состояние.

-- ── 1. Выпрямить цепочки слияний (3 прохода — до четырёх звеньев) ────────
UPDATE kamchatka_routes m
SET merged_into_id = t.merged_into_id, updated_at = NOW()
FROM kamchatka_routes t
WHERE m.merged_into_id::text = t.id::text
  AND t.merged_into_id IS NOT NULL
  AND t.merged_into_id::text <> m.id::text;

UPDATE kamchatka_routes m
SET merged_into_id = t.merged_into_id, updated_at = NOW()
FROM kamchatka_routes t
WHERE m.merged_into_id::text = t.id::text
  AND t.merged_into_id IS NOT NULL
  AND t.merged_into_id::text <> m.id::text;

UPDATE kamchatka_routes m
SET merged_into_id = t.merged_into_id, updated_at = NOW()
FROM kamchatka_routes t
WHERE m.merged_into_id::text = t.id::text
  AND t.merged_into_id IS NOT NULL
  AND t.merged_into_id::text <> m.id::text;

-- ── 2. Инвариант: слитая ⇒ скрыта ────────────────────────────────────────
UPDATE kamchatka_routes
SET is_visible = false, updated_at = NOW()
WHERE merged_into_id IS NOT NULL
  AND is_visible = true;

UPDATE places
SET is_visible = false, updated_at = NOW()
WHERE merged_into_id IS NOT NULL
  AND is_visible = true;
