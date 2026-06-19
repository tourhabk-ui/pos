-- Цунами-риск для прибрежных зон.
-- Пляжи и прибрежные места помечаются как tsunami_risk = TRUE
-- и включаются в геофенс как отдельный тип опасности.
ALTER TABLE location_safety_profile ADD COLUMN IF NOT EXISTS tsunami_risk BOOLEAN NOT NULL DEFAULT FALSE;

-- Пометить все места с типом beach/ocean/coast как цунами-зоны.
UPDATE location_safety_profile lsp
SET tsunami_risk = TRUE
FROM places p
WHERE lsp.agent_route_id = p.ark_id
  AND p.location_type IN ('beach', 'ocean', 'coast', 'coastal');

-- Халатырский пляж и Авачинский залив — принудительно, если не попали в UPDATE выше.
UPDATE location_safety_profile lsp
SET tsunami_risk = TRUE
FROM places p
WHERE lsp.agent_route_id = p.ark_id
  AND (
    p.name ILIKE '%халат%'
    OR p.name ILIKE '%авачинск%залив%'
    OR p.name ILIKE '%тихий океан%'
  );
