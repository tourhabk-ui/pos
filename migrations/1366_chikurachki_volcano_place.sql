-- 1366: вулкан Чикурачки в справочнике мест (issue #2888).
--
-- KVERT ведёт Чикурачки (о. Парамушир, Северные Курилы, Сахалинская обл.), а
-- места в `places` не было: get_guardian_context отвечал «места нет — статус
-- не рассчитан» при жёлтом коде. Владелец 02.11: «го».
--
-- Координата — Global Volcanism Program (Smithsonian), вулкан 290360:
-- 50.324° с. ш., 155.461° в. д., высота 1781 м. Внешний справочник →
-- coord_source = 'external'. Описание не пишется (урок 986).
-- Зона kuril_north — как у Эбеко и Алаида (миграция 1299).
BEGIN;

INSERT INTO places (id, name, ark_id, lat, lng, location_type, zone,
                    is_visible, coord_source, coord_source_at,
                    source_name, source_url, created_at, updated_at)
VALUES ('42c3619b-2a94-496c-9765-1b97c6b8cc1a',
        'Вулкан Чикурачки',
        '0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379',
        50.324, 155.461,
        'volcano', 'kuril_north',
        TRUE, 'external', NOW(),
        'Global Volcanism Program (Smithsonian), №290360',
        'https://volcano.si.edu/volcano.cfm?vn=290360',
        NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- «Не знаем» до прогона safety-ingest — как в 1293.
INSERT INTO location_real_time_status (agent_route_id, is_open, recommender_status)
VALUES ('0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379', NULL, NULL)
ON CONFLICT (agent_route_id) DO NOTHING;

-- Уже записанный статус KVERT — к новой точке; следующий kvert-sync
-- сопоставит сам (COALESCE не затирает привязку).
UPDATE volcano_status
   SET place_ark_id = '0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379'
 WHERE place_ark_id IS NULL
   AND (lower(volcano_name) LIKE '%chikurachki%' OR lower(name_normalized) LIKE '%chikurachki%'
        OR lower(volcano_name) LIKE '%чикурачки%' OR lower(name_normalized) LIKE '%чикурачки%');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM places WHERE id::text = '42c3619b-2a94-496c-9765-1b97c6b8cc1a' AND is_visible) THEN
    RAISE WARNING '[1366] место «Вулкан Чикурачки» не заведено';
  END IF;
END $$;

COMMIT;

-- Rollback:
-- DELETE FROM location_real_time_status WHERE agent_route_id = '0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379';
-- UPDATE volcano_status SET place_ark_id = NULL WHERE place_ark_id = '0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379';
-- DELETE FROM places WHERE id = '42c3619b-2a94-496c-9765-1b97c6b8cc1a';
