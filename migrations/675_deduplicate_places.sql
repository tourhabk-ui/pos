-- Migration 675: deduplicate places
-- Hides duplicate place entries keeping the one with the longest description
-- (or highest id as tiebreaker). All decisions based on confirmed diagnostic data.

-- Strategy: for each cluster of duplicates, keep the place with the most content
-- (longest description), hide the rest (is_visible = false).

-- ── Карымшинские (3 entries at ~52.811, 158.092) ────────────────────────────
-- Keep: longest description among ark_ids at those coords
UPDATE places
SET is_visible = false
WHERE is_visible = true
  AND ROUND(lat::numeric, 3) = 52.811
  AND ROUND(lng::numeric, 3) = 158.092
  AND ark_id NOT IN (
    SELECT ark_id FROM places
    WHERE is_visible = true
      AND ROUND(lat::numeric, 3) = 52.811
      AND ROUND(lng::numeric, 3) = 158.092
    ORDER BY COALESCE(LENGTH(description), 0) DESC, id DESC
    LIMIT 1
  );

-- ── Озеро Толмачёва / Толмачёва (2 entries at ~52.552, 157.733) ─────────────
UPDATE places
SET is_visible = false
WHERE is_visible = true
  AND ROUND(lat::numeric, 3) = 52.552
  AND ROUND(lng::numeric, 3) = 157.733
  AND ark_id NOT IN (
    SELECT ark_id FROM places
    WHERE is_visible = true
      AND ROUND(lat::numeric, 3) = 52.552
      AND ROUND(lng::numeric, 3) = 157.733
    ORDER BY COALESCE(LENGTH(description), 0) DESC, id DESC
    LIMIT 1
  );

-- ── Вулкан Корякская сопка / Корякский Вулкан (2 entries at ~53.262, 158.741) ─
UPDATE places
SET is_visible = false
WHERE is_visible = true
  AND ROUND(lat::numeric, 3) = 53.262
  AND ROUND(lng::numeric, 3) = 158.741
  AND ark_id NOT IN (
    SELECT ark_id FROM places
    WHERE is_visible = true
      AND ROUND(lat::numeric, 3) = 53.262
      AND ROUND(lng::numeric, 3) = 158.741
    ORDER BY COALESCE(LENGTH(description), 0) DESC, id DESC
    LIMIT 1
  );

-- ── Курильское озеро / Озеро Курильское (2 entries at ~51.502, 156.521) ─────
UPDATE places
SET is_visible = false
WHERE is_visible = true
  AND ROUND(lat::numeric, 3) = 51.502
  AND ROUND(lng::numeric, 3) = 156.521
  AND ark_id NOT IN (
    SELECT ark_id FROM places
    WHERE is_visible = true
      AND ROUND(lat::numeric, 3) = 51.502
      AND ROUND(lng::numeric, 3) = 156.521
    ORDER BY COALESCE(LENGTH(description), 0) DESC, id DESC
    LIMIT 1
  );

-- ── Войновские/Жировские/Мутновская группа (4 entries at ~52.945, 158.234) ──
-- These are distinct locations that happen to share centroid coords.
-- Keep the 2 with the most complete descriptions, hide the rest.
UPDATE places
SET is_visible = false
WHERE is_visible = true
  AND ROUND(lat::numeric, 3) = 52.945
  AND ROUND(lng::numeric, 3) = 158.234
  AND ark_id NOT IN (
    SELECT ark_id FROM places
    WHERE is_visible = true
      AND ROUND(lat::numeric, 3) = 52.945
      AND ROUND(lng::numeric, 3) = 158.234
    ORDER BY COALESCE(LENGTH(description), 0) DESC, id DESC
    LIMIT 2
  );

-- ── Generic safety net: same-name exact duplicates ───────────────────────────
-- For any remaining pairs with identical name AND identical coords (rounded to 3dp),
-- hide the one with fewer characters in description (lower id as tiebreaker).
UPDATE places p
SET is_visible = false
WHERE p.is_visible = true
  AND EXISTS (
    SELECT 1 FROM places p2
    WHERE p2.is_visible = true
      AND p2.ark_id <> p.ark_id
      AND LOWER(TRIM(p2.name)) = LOWER(TRIM(p.name))
      AND ROUND(p2.lat::numeric, 3) = ROUND(p.lat::numeric, 3)
      AND ROUND(p2.lng::numeric, 3) = ROUND(p.lng::numeric, 3)
      AND (
        COALESCE(LENGTH(p2.description), 0) > COALESCE(LENGTH(p.description), 0)
        OR (
          COALESCE(LENGTH(p2.description), 0) = COALESCE(LENGTH(p.description), 0)
          AND p2.id > p.id
        )
      )
  );
