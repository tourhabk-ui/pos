-- 881: два решения владельца 20.08 по остаткам операции «скрытые треки».
--
-- 1) «Озеро Толмачево» (5f699074) и «Озеро Толмачева» (a937455c) жили на
--    витрине ОБА — два лица одного озера (названо по фамилии Толмачёва;
--    каждое к 20.08 уже впитало своего скрытого дубля пробой 99). Владелец
--    выбрал «Толмачёва»: a937455c остаётся и получает написание с ё,
--    5f699074 сливается в неё. Правила — те же, что у актуатора
--    route-family-merge: путевые точки переезжают (существующие не
--    трогаются), туры перевешиваются, слитая хранит свой трек — у обеих
--    записей настоящие снятые линии, а снятое не перетирается.
--
-- 2) «Корякский Вулкан» (769103e5, скрытый, трек external на 248 вершин) —
--    последняя запись переписи 20.08 без решения: перепись ищет живую
--    тёзку по точному имени и перестановки слов («Вулкан Корякский») не
--    видит. Здесь тёзка ищется обеими перестановками: есть — слить в неё
--    (трек отдать, если у живой пусто или перезаписываемый источник),
--    нет — вернуть запись на витрину под выправленным именем.
--
-- Идемпотентно: все шаги под guard (merged_into_id IS NULL, точное старое
-- название, NOT EXISTS) — повторный прогон не находит строк.

-- ── 1. Толмачёва ────────────────────────────────────────────────────────

-- Путевые точки 5f699074 доезжают до a937455c, позиции — в хвост.
INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
SELECT l.id, rw.place_id,
       COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id::text = l.id::text), 0)
         + ROW_NUMBER() OVER (ORDER BY rw.position),
       rw.link_kind, rw.link_kind_at
FROM route_waypoints rw
JOIN kamchatka_routes h ON h.id::text = rw.route_id::text AND h.id::text = '5f699074-6a1a-4dec-8487-d5bfb7a3ebb5'
JOIN kamchatka_routes l ON l.id::text = 'a937455c-ec61-407c-89a8-f8303402a6be'
WHERE NOT EXISTS (
  SELECT 1 FROM route_waypoints x WHERE x.route_id::text = l.id::text AND x.place_id::text = rw.place_id::text
)
ON CONFLICT (route_id, place_id) DO NOTHING;

-- Туры, смотревшие на уходящую запись, перевешиваются на остающуюся.
UPDATE operator_tours
SET route_id = (SELECT id FROM kamchatka_routes WHERE id::text = 'a937455c-ec61-407c-89a8-f8303402a6be')
WHERE route_id::text = '5f699074-6a1a-4dec-8487-d5bfb7a3ebb5';

-- Уходящая скрывается и помечается слитой; её трек остаётся при ней.
UPDATE kamchatka_routes
SET is_visible = false,
    merged_into_id = (SELECT id FROM kamchatka_routes WHERE id::text = 'a937455c-ec61-407c-89a8-f8303402a6be'),
    updated_at = NOW()
WHERE id::text = '5f699074-6a1a-4dec-8487-d5bfb7a3ebb5'
  AND merged_into_id IS NULL;

-- Выбранное владельцем написание — с ё.
UPDATE kamchatka_routes
SET title = 'Озеро Толмачёва', updated_at = NOW()
WHERE id::text = 'a937455c-ec61-407c-89a8-f8303402a6be'
  AND title = 'Озеро Толмачева';

-- ── 2. Корякский ────────────────────────────────────────────────────────

-- Трек скрытой — живой тёзке, только поверх пустоты или перезаписываемого
-- источника (правило family-merge: снятое не перетирается).
UPDATE kamchatka_routes l
SET geometry = h.geometry, updated_at = NOW()
FROM kamchatka_routes h
WHERE h.id::text = '769103e5-d011-4045-a6ba-af092760324f'
  AND h.geometry IS NOT NULL
  AND l.id::text <> h.id::text
  AND l.is_visible = true AND l.merged_into_id IS NULL
  AND translate(lower(btrim(l.title)), 'ё', 'е') IN ('вулкан корякский', 'корякский вулкан')
  AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'));

-- Есть живая тёзка (в любой перестановке) — слить в неё.
UPDATE kamchatka_routes h
SET merged_into_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE l.id::text <> h.id::text
        AND l.is_visible = true AND l.merged_into_id IS NULL
        AND translate(lower(btrim(l.title)), 'ё', 'е') IN ('вулкан корякский', 'корякский вулкан')
      ORDER BY l.id::text
      LIMIT 1
    ),
    updated_at = NOW()
WHERE h.id::text = '769103e5-d011-4045-a6ba-af092760324f'
  AND h.merged_into_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kamchatka_routes l
    WHERE l.id::text <> h.id::text
      AND l.is_visible = true AND l.merged_into_id IS NULL
      AND translate(lower(btrim(l.title)), 'ё', 'е') IN ('вулкан корякский', 'корякский вулкан')
  );

-- Тёзки нет — запись возвращается на витрину под выправленным именем.
UPDATE kamchatka_routes
SET is_visible = true, title = 'Вулкан Корякский', updated_at = NOW()
WHERE id::text = '769103e5-d011-4045-a6ba-af092760324f'
  AND merged_into_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM kamchatka_routes l
    WHERE l.id::text <> '769103e5-d011-4045-a6ba-af092760324f'
      AND l.is_visible = true AND l.merged_into_id IS NULL
      AND translate(lower(btrim(l.title)), 'ё', 'е') IN ('вулкан корякский', 'корякский вулкан')
  );
