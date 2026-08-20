-- 886: доводка слияния вариаций (885) — id двух пространств.
--
-- УРОК: /api/routes/search отдаёт id в пространстве VIEW —
-- COALESCE(ark_id, id) (см. комментарий в самом роуте: этим id потребители
-- идут в /api/routes/{id}). Миграция 885 взяла их как kamchatka_routes.id:
-- три пары не нашлись вовсе («К скалам Три брата», «Голубые озёра на
-- Камчатке!», «Поход вокруг Толбачиков. Камчатка»), а у нашедшихся
-- loser'ов с ark-survivor'ом подзапрос цели вернул NULL — записи скрыты
-- БЕЗ merged_into_id (лимб: «Поход вокруг Толбачиков», возможно пары
-- Быстрой). Трек «Вокруг Толбачиков» не переехал. Отсюда правило: id из
-- search в миграции не годится без матча по ОБОИМ пространствам.
--
-- Здесь каждая сторона ищется как id ИЛИ ark_id; скрытая-без-слитости
-- получает merged_into_id (починка лимба тем же UPDATE); hide не
-- выполняется без найденного выжившего. Идемпотентно.

-- ── Путевые точки уходящих доезжают до остающихся ───────────────────────
INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
SELECT l.id, rw.place_id,
       COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id::text = l.id::text), 0)
         + ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY rw.position),
       rw.link_kind, rw.link_kind_at
FROM (VALUES
  ('4515a2ce-7c0f-4fd0-a4eb-54e7a0b31f27', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('0d3a3202-4826-4c52-8ecb-6274319577ff', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('61dcdc21-7d6a-4ccd-834e-7d9394176bd9', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('98a86d9c-1f2a-4b70-a338-0014bcea1cc5', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('9a45a836-ff6a-46b6-b054-a1a429ee82e3', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('a1aa4197-3070-47cc-8ac5-b0d5a54a5388', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('5d859de1-9556-4647-96ae-7103e2b7286e', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('0e471edd-7982-4e35-b8b8-423e0f383833', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('982975bf-3503-470e-87af-e2da48a3f1d5', '746668e0-cbdc-4b70-bb1c-d80932a29ece')
) AS p(loser, survivor)
JOIN kamchatka_routes h
  ON (h.id::text = p.loser OR h.ark_id::text = p.loser)
JOIN kamchatka_routes l
  ON (l.id::text = p.survivor OR l.ark_id::text = p.survivor)
 AND l.is_visible = true AND l.merged_into_id IS NULL
JOIN route_waypoints rw ON rw.route_id::text = h.id::text
WHERE h.id::text <> l.id::text
  AND NOT EXISTS (
    SELECT 1 FROM route_waypoints x
    WHERE x.route_id::text = l.id::text AND x.place_id::text = rw.place_id::text
  )
ON CONFLICT (route_id, place_id) DO NOTHING;

-- ── Туры уходящих перевешиваются на остающиеся ──────────────────────────
UPDATE operator_tours t
SET route_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE (l.id::text = p.survivor OR l.ark_id::text = p.survivor)
        AND l.is_visible = true AND l.merged_into_id IS NULL
      ORDER BY l.id::text
      LIMIT 1
    )
FROM (VALUES
  ('4515a2ce-7c0f-4fd0-a4eb-54e7a0b31f27', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('0d3a3202-4826-4c52-8ecb-6274319577ff', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('61dcdc21-7d6a-4ccd-834e-7d9394176bd9', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('98a86d9c-1f2a-4b70-a338-0014bcea1cc5', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('9a45a836-ff6a-46b6-b054-a1a429ee82e3', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('a1aa4197-3070-47cc-8ac5-b0d5a54a5388', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('5d859de1-9556-4647-96ae-7103e2b7286e', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('0e471edd-7982-4e35-b8b8-423e0f383833', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('982975bf-3503-470e-87af-e2da48a3f1d5', '746668e0-cbdc-4b70-bb1c-d80932a29ece')
) AS p(loser, survivor)
JOIN kamchatka_routes h
  ON (h.id::text = p.loser OR h.ark_id::text = p.loser)
WHERE t.route_id::text = h.id::text
  AND EXISTS (
    SELECT 1 FROM kamchatka_routes l2
    WHERE (l2.id::text = p.survivor OR l2.ark_id::text = p.survivor)
      AND l2.is_visible = true AND l2.merged_into_id IS NULL
      AND l2.id::text <> h.id::text
  );

-- ── Трек: «Вокруг Толбачиков» без линии берёт трек слитого «Похода» ─────
UPDATE kamchatka_routes l
SET geometry = h.geometry, updated_at = NOW()
FROM kamchatka_routes h
WHERE (h.id::text = '9a45a836-ff6a-46b6-b054-a1a429ee82e3' OR h.ark_id::text = '9a45a836-ff6a-46b6-b054-a1a429ee82e3')
  AND (l.id::text = 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d' OR l.ark_id::text = 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d')
  AND l.is_visible = true AND l.merged_into_id IS NULL
  AND h.id::text <> l.id::text
  AND h.geometry IS NOT NULL
  AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'));

-- ── Скрыть и пометить слитыми; лимб 885 (скрыт без слитости) чинится тем
--    же UPDATE — guard только по merged_into_id, живость выжившего строгая ──
UPDATE kamchatka_routes h
SET is_visible = false,
    merged_into_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE (l.id::text = p.survivor OR l.ark_id::text = p.survivor)
        AND l.is_visible = true AND l.merged_into_id IS NULL
      ORDER BY l.id::text
      LIMIT 1
    ),
    updated_at = NOW()
FROM (VALUES
  ('4515a2ce-7c0f-4fd0-a4eb-54e7a0b31f27', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('0d3a3202-4826-4c52-8ecb-6274319577ff', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('61dcdc21-7d6a-4ccd-834e-7d9394176bd9', '7ae7d778-2cdc-4655-8c9c-0dc36713a278'),
  ('98a86d9c-1f2a-4b70-a338-0014bcea1cc5', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('9a45a836-ff6a-46b6-b054-a1a429ee82e3', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('a1aa4197-3070-47cc-8ac5-b0d5a54a5388', 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'),
  ('5d859de1-9556-4647-96ae-7103e2b7286e', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('0e471edd-7982-4e35-b8b8-423e0f383833', '8d196361-c07c-4f5e-ae03-73cdc2433b97'),
  ('982975bf-3503-470e-87af-e2da48a3f1d5', '746668e0-cbdc-4b70-bb1c-d80932a29ece')
) AS p(loser, survivor)
WHERE (h.id::text = p.loser OR h.ark_id::text = p.loser)
  AND h.merged_into_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kamchatka_routes l2
    WHERE (l2.id::text = p.survivor OR l2.ark_id::text = p.survivor)
      AND l2.is_visible = true AND l2.merged_into_id IS NULL
      AND l2.id::text <> h.id::text
  );

-- ── Тур рафтеров: маршрут-тёзка с треком (повтор 885 в обоих пространствах) ──
UPDATE operator_tours t
SET route_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE (l.id::text = '8d196361-c07c-4f5e-ae03-73cdc2433b97' OR l.ark_id::text = '8d196361-c07c-4f5e-ae03-73cdc2433b97')
        AND l.is_visible = true AND l.merged_into_id IS NULL
      ORDER BY l.id::text
      LIMIT 1
    )
WHERE t.id::text = '27'
  AND t.route_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kamchatka_routes l2
    WHERE (l2.id::text = '8d196361-c07c-4f5e-ae03-73cdc2433b97' OR l2.ark_id::text = '8d196361-c07c-4f5e-ae03-73cdc2433b97')
      AND l2.is_visible = true AND l2.merged_into_id IS NULL
  );
