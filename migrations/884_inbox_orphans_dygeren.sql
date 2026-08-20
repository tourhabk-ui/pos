-- 884: сироты переигранного инбокса + Дыгерен-тёзки (владелец 20.08).
--
-- 1) Инбокс переигрывает ВСЮ папку каждым пушем, а слияния 20.08 убрали
--    его прежние цели: vodopad-spokoynyy.kml больше не нашёл тёзку
--    (живая переименована в «Водопад Спокойный (Снежный Барс)») и создал
--    НОВУЮ скрытую «Водопад Спокойный (Косы Вероники)»; ozero-tolmachevo.kml
--    налил 494-точечный трек в скрытую «Озеро Толмачево» (живая тёзка
--    слита в «Озеро Толмачёва», а ё→е нормализация не покрывает о/а).
--    Обе сироты сливаются в своих живых наследников; сами файлы из папки
--    удалены этим же коммитом — инбокс лоток, не архив.
--
-- 2) «Вулкан Дыгерен-Оленгендэ» и «Вулкан Дыгерен–Оленгендэ» — один
--    объект, живут на витрине оба: дефис против тире, нормализация
--    инбокса их семьёй видит, но обе записи живые — актуатор такие не
--    берёт. Выживает запись с данными (17 км, hard, eb9d4055), к ней
--    переезжают путевые точки тёзки; имя выправляется на дефисное.
--
-- Идемпотентно: guard по merged_into_id IS NULL и точным старым именам.

-- ── 1а. Скрытая сирота Спокойного → живой Снежный Барс ──────────────────
UPDATE kamchatka_routes h
SET merged_into_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE l.id::text = '0a0c055d-dbf6-461b-a3d2-30803469b62e'
    ),
    updated_at = NOW()
WHERE h.title = 'Водопад Спокойный (Косы Вероники)'
  AND h.is_visible = false
  AND h.merged_into_id IS NULL;

-- ── 1б. Скрытая сирота Толмачево → живая Толмачёва ──────────────────────
UPDATE kamchatka_routes h
SET merged_into_id = (
      SELECT l.id FROM kamchatka_routes l
      WHERE l.id::text = 'a937455c-ec61-407c-89a8-f8303402a6be'
    ),
    updated_at = NOW()
WHERE h.title = 'Озеро Толмачево'
  AND h.is_visible = false
  AND h.merged_into_id IS NULL;

-- ── 2. Дыгерен: путевые точки тёзки переезжают выжившей ─────────────────
INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
SELECT l.id, rw.place_id,
       COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id::text = l.id::text), 0)
         + ROW_NUMBER() OVER (ORDER BY rw.position),
       rw.link_kind, rw.link_kind_at
FROM route_waypoints rw
JOIN kamchatka_routes h ON h.id::text = rw.route_id::text AND h.id::text = 'f606bad9-3a94-4394-80cf-b86161823c27'
JOIN kamchatka_routes l ON l.id::text = 'eb9d4055-53cf-45a5-9751-276b124b0ccf'
WHERE NOT EXISTS (
  SELECT 1 FROM route_waypoints x
  WHERE x.route_id::text = l.id::text AND x.place_id::text = rw.place_id::text
)
ON CONFLICT (route_id, place_id) DO NOTHING;

UPDATE operator_tours
SET route_id = (SELECT id FROM kamchatka_routes WHERE id::text = 'eb9d4055-53cf-45a5-9751-276b124b0ccf')
WHERE route_id::text = 'f606bad9-3a94-4394-80cf-b86161823c27';

UPDATE kamchatka_routes
SET is_visible = false,
    merged_into_id = (SELECT id FROM kamchatka_routes WHERE id::text = 'eb9d4055-53cf-45a5-9751-276b124b0ccf'),
    updated_at = NOW()
WHERE id::text = 'f606bad9-3a94-4394-80cf-b86161823c27'
  AND merged_into_id IS NULL;

-- Имя выжившей — дефисная форма (тире в имени было единственным отличием).
UPDATE kamchatka_routes
SET title = 'Вулкан Дыгерен-Оленгендэ', updated_at = NOW()
WHERE id::text = 'eb9d4055-53cf-45a5-9751-276b124b0ccf'
  AND title = 'Вулкан Дыгерен–Оленгендэ';
