-- 882: слияние транслит-дублей витрины + клубок Спокойных (владелец 20.08:
-- перепись route-translit-census предъявлена, решение делегировано).
--
-- Транслит-перепись (проба 102) нашла на витрине 5 латинских записей —
-- след скрейпа, те же объекты с именем в транслите. Четыре — точные семьи
-- кириллических записей; сливаются в них по правилам family-merge:
-- путевые точки переезжают, туры перевешиваются, слитая хранит свой трек.
-- Трек переезжает живой только поверх пустоты/перезаписываемого —
-- выигрывает «Бухта Пионерская», у которой линии не было, а у латинской
-- тёзки была.
--
-- Пятая латинская — «vodopad snezhnyy bars na ruche spokoynyy» — вскрыла
-- клубок: ЧЕТЫРЕ записи одного водопада на ручье Спокойном (он же
-- «Снежный барс», он же «Косы Вероники»): латинская с треком, «Водопад
-- Спокойный» с треком, «Водопад на ручье Спокойный» без трека с 4
-- путевыми точками и скрытая «Водопад Спокойный (Косы Вероники)» со
-- 118-точечным KML из инбокса. Выживает запись с точками (0a0c055d),
-- получает трек из нашего KML (файл инбокса — происхождение знаем) и имя
-- с известным алиасом; остальные три сливаются в неё.
--
-- Семья имён их не видела намеренно: разные алфавиты и разные наборы слов
-- не совпадают токенами — поэтому слияние здесь, решением человека, а не
-- актуатором.
--
-- Идемпотентно: guards по merged_into_id IS NULL, точному старому имени
-- и перезаписываемости геометрии.

-- ── Путевые точки всех уходящих доезжают до остающихся ──────────────────
INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
SELECT l.id, rw.place_id,
       COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id::text = l.id::text), 0)
         + ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY rw.position),
       rw.link_kind, rw.link_kind_at
FROM (VALUES
  ('cd64be82-c893-492d-ac0b-ebf780284be3', 'be1c6c4a-33d8-4b3f-8025-2230654758f2'),
  ('722a15ba-0096-47a4-b276-b6f4977ac7a3', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('80c19b1d-b30f-47c2-b215-f947dab94a5d', '36c5ef4d-d171-41b9-b1a5-61783b1a3f8e'),
  ('2b64c810-b977-47a7-9a2b-694271d81aa7', '87550ffc-91ba-4aff-adcc-3b211f38d733'),
  ('5c5c9a91-0c0c-4faa-aa05-f538873dab59', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('bd0ec86c-dde6-4781-824a-a284fa154d31', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('f7c53b66-87e2-4bbf-aefd-d57039b2f037', '0a0c055d-dbf6-461b-a3d2-30803469b62e')
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
  ('cd64be82-c893-492d-ac0b-ebf780284be3', 'be1c6c4a-33d8-4b3f-8025-2230654758f2'),
  ('722a15ba-0096-47a4-b276-b6f4977ac7a3', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('80c19b1d-b30f-47c2-b215-f947dab94a5d', '36c5ef4d-d171-41b9-b1a5-61783b1a3f8e'),
  ('2b64c810-b977-47a7-9a2b-694271d81aa7', '87550ffc-91ba-4aff-adcc-3b211f38d733'),
  ('5c5c9a91-0c0c-4faa-aa05-f538873dab59', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('bd0ec86c-dde6-4781-824a-a284fa154d31', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('f7c53b66-87e2-4bbf-aefd-d57039b2f037', '0a0c055d-dbf6-461b-a3d2-30803469b62e')
) AS p(loser, survivor)
WHERE t.route_id::text = p.loser;

-- ── Треки: только явные переезды, генерического правила нет намеренно ───
-- Бухта Пионерская: линии не было — берёт трек латинской тёзки.
UPDATE kamchatka_routes l
SET geometry = h.geometry, updated_at = NOW()
FROM kamchatka_routes h
WHERE h.id::text = '80c19b1d-b30f-47c2-b215-f947dab94a5d'
  AND l.id::text = '36c5ef4d-d171-41b9-b1a5-61783b1a3f8e'
  AND h.geometry IS NOT NULL
  AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'));

-- Спокойный: выживающая запись берёт 118-точечный KML скрытой «Косы
-- Вероники». Донор указан поимённо, а не правилом: иначе следом идущий
-- external-трек латинской перетёр бы kml_inbox — тот числится
-- перезаписываемым.
UPDATE kamchatka_routes l
SET geometry = h.geometry, updated_at = NOW()
FROM kamchatka_routes h
WHERE h.id::text = 'f7c53b66-87e2-4bbf-aefd-d57039b2f037'
  AND l.id::text = '0a0c055d-dbf6-461b-a3d2-30803469b62e'
  AND h.geometry IS NOT NULL
  AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'));

-- ── Уходящие скрываются и помечаются слитыми ────────────────────────────
UPDATE kamchatka_routes h
SET is_visible = false,
    merged_into_id = (SELECT k.id FROM kamchatka_routes k WHERE k.id::text = p.survivor),
    updated_at = NOW()
FROM (VALUES
  ('cd64be82-c893-492d-ac0b-ebf780284be3', 'be1c6c4a-33d8-4b3f-8025-2230654758f2'),
  ('722a15ba-0096-47a4-b276-b6f4977ac7a3', '3f4ebeaf-53e2-43f6-a0e8-ffe4c4142ab2'),
  ('80c19b1d-b30f-47c2-b215-f947dab94a5d', '36c5ef4d-d171-41b9-b1a5-61783b1a3f8e'),
  ('2b64c810-b977-47a7-9a2b-694271d81aa7', '87550ffc-91ba-4aff-adcc-3b211f38d733'),
  ('5c5c9a91-0c0c-4faa-aa05-f538873dab59', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('bd0ec86c-dde6-4781-824a-a284fa154d31', '0a0c055d-dbf6-461b-a3d2-30803469b62e'),
  ('f7c53b66-87e2-4bbf-aefd-d57039b2f037', '0a0c055d-dbf6-461b-a3d2-30803469b62e')
) AS p(loser, survivor)
WHERE h.id::text = p.loser
  AND h.merged_into_id IS NULL;

-- ── Имя выжившего Спокойного: известный алиас — в скобки ────────────────
UPDATE kamchatka_routes
SET title = 'Водопад Спокойный (Снежный Барс)', updated_at = NOW()
WHERE id::text = '0a0c055d-dbf6-461b-a3d2-30803469b62e'
  AND title = 'Водопад на ручье Спокойный';
