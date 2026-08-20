-- 885: слияние вариаций одного продукта («го» владельца 20.08 по списку).
--
-- Пять групп записей, где один объект/один путь жил под несколькими
-- именами-вариациями. Семья имён их не видит намеренно (наборы слов
-- разные), решение принято владельцем поимённо:
--
--   Скалы Три Брата (7ae7d778, паспорт visitkamchatka, surveyed) ←
--     «Вечерняя прогулка на Три брата» (4515a2ce),
--     «К скалам Три брата» (0d3a3202),
--     «Смотровая площадка «Три брата»» (61dcdc21);
--   Голубые озёра (3f4ebeaf) ← «Голубые озёра на Камчатке!» (98a86d9c);
--   Вокруг Толбачиков (f7d4acc0, 60 км, паспорт с данными, БЕЗ линии) ←
--     «Поход вокруг Толбачиков» (9a45a836, external-трек — переезжает
--     выжившей), «Поход вокруг Толбачиков. Камчатка» (a1aa4197);
--   Сплав по реке Быстрая (8d196361, трек) ←
--     «Путешествие по реке Быстрая» (5d859de1), «Река Быстрая» (0e471edd);
--   Вулкан Ичинская сопка (746668e0, наш KML, surveyed) ←
--     «Ичинский Вулкан» (982975bf, external 81 км — трек при слитой).
--
-- Правила те же, что у актуатора: путевые точки переезжают, туры
-- перевешиваются, слитая хранит свой трек; трек переезжает только там,
-- где у выжившей пусто (Вокруг Толбачиков), и донор назван поимённо.
-- Плюс: тур «Сплав по реке Быстрая» (id 27, Камчатка Семейный Рафтинг)
-- впервые получает маршрут — свою тёзку с треком.
--
-- Идемпотентно: guards по merged_into_id IS NULL и пустоте геометрии.

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
JOIN kamchatka_routes h ON h.id::text = p.loser
JOIN kamchatka_routes l ON l.id::text = p.survivor
JOIN route_waypoints rw ON rw.route_id::text = h.id::text
WHERE NOT EXISTS (
  SELECT 1 FROM route_waypoints x
  WHERE x.route_id::text = l.id::text AND x.place_id::text = rw.place_id::text
)
ON CONFLICT (route_id, place_id) DO NOTHING;

-- ── Туры уходящих перевешиваются на остающиеся ──────────────────────────
UPDATE operator_tours t
SET route_id = (SELECT k.id FROM kamchatka_routes k WHERE k.id::text = p.survivor)
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
WHERE t.route_id::text = p.loser;

-- ── Трек: единственный переезд — «Вокруг Толбачиков» без линии ──────────
-- Донор назван поимённо («Поход вокруг Толбачиков», external): генерическое
-- правило могло бы дать второму «Походу» перетереть первого.
UPDATE kamchatka_routes l
SET geometry = h.geometry, updated_at = NOW()
FROM kamchatka_routes h
WHERE h.id::text = '9a45a836-ff6a-46b6-b054-a1a429ee82e3'
  AND l.id::text = 'f7d4acc0-76d7-4f8d-bb13-f8ee75982c3d'
  AND h.geometry IS NOT NULL
  AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'));

-- ── Уходящие скрываются и помечаются слитыми ────────────────────────────
UPDATE kamchatka_routes h
SET is_visible = false,
    merged_into_id = (SELECT k.id FROM kamchatka_routes k WHERE k.id::text = p.survivor),
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
WHERE h.id::text = p.loser
  AND h.merged_into_id IS NULL;

-- ── Тур рафтеров впервые получает маршрут: свою тёзку с треком ──────────
UPDATE operator_tours t
SET route_id = (SELECT k.id FROM kamchatka_routes k WHERE k.id::text = '8d196361-c07c-4f5e-ae03-73cdc2433b97')
WHERE t.id::text = '27'
  AND t.route_id IS NULL;
