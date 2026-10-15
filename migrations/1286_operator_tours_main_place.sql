-- 1286: тур называет своё главное место — явной связью, а не близостью
--
-- Аудит 15.10, находка TOUR-PLACE.
--
-- У живых туров, заведённых миграциями (955, 1106, 1176, 1217), пуст
-- operator_tours.route_id: INSERT его не называет, а кабинет его править не
-- даёт. Единственная цепочка «место → тур» шла через маршрут
-- (route_waypoints → kamchatka_routes → operator_tours.route_id), поэтому
-- блок «Туры сюда» на карточке места и правило китайских конспектов мест
-- (lib/zh/content.ts, zhPlaceRuleSql) на проде давали ноль: перевод 15.10 в
-- сухом прогоне — мест 0 при 37 живых турах.
--
-- ── Колонки ────────────────────────────────────────────────────────────────
--   main_place_id     — places.id главного места тура (text, как у
--                       transfer_charter_prices.place_id, 1232). NULL — «не
--                       связано», и это честный ответ, а не пробел для догадки.
--                       ON DELETE SET NULL: удалённое место связь снимает.
--   main_place_source — откуда связь: 'coords_equal' — заполнено здесь по
--                       точному совпадению координат; 'operator' — выбрано
--                       оператором в кабинете (PATCH тура). Других источников
--                       нет, и CHECK это держит.
--
-- ── Почему РАВЕНСТВО координат, а не близость ─────────────────────────────
-- CLAUDE.md §4.1: род связи по близости не выводится — иначе всё неудобное
-- переименуется в «рядом», и черта пройдёт любая. §14: связь с местом
-- пишется адресом, сверенным вручную, а не похожестью имени при чтении
-- («Авачинский» — и вулкан, и перевал, и бухта).
--
-- Точное равенство — не близость, а улика происхождения. Шапка 1217
-- (строки 51-53): координаты туров «Местечка» — «главное место тура из базы
-- Ведара (places через MCP get_place_info 12.10)», то есть скопированы из
-- places. Число, совпавшее до последнего знака с координатой ровно одного
-- живого места, — след этой копии; совпадение «рядом, в сотне метров» — уже
-- догадка, и её здесь нет.
--
-- Поэтому связь ставится только когда:
--   - у тура обе координаты записаны (у тура озера Толмачёва в 1217 они NULL —
--     связи нет);
--   - ровно ОДНО видимое и не слитое место имеет lat = latitude и
--     lng = longitude (numeric-равенство, без допуска и без имён). Два места
--     в одной точке — не улика, какое из них главное; связи нет.
--
-- Туры 1176 (VolcanoesLand) несут координаты, названные в шапке
-- «приблизительно»: так они не свяжутся — и это честное «не связано»,
-- а не недосмотр. Их и остальные свяжет оператор в кабинете (поле «Главное
-- место тура») или следующая миграция с адресом места, сверенным вручную.
-- Сколько живых туров осталось без связи, называет перепись
-- GET /api/cron/tour-tracks-census (блок place_link).
--
-- ── Идемпотентность ────────────────────────────────────────────────────────
-- Колонки — IF NOT EXISTS, ограничения — по наличию, индекс — IF NOT EXISTS,
-- заполнение — только в пустое поле: выбор оператора не перетирается, и
-- повторный прогон ничего не меняет. Без BEGIN/COMMIT: транзакцию даёт
-- раннер миграций.

ALTER TABLE operator_tours
  ADD COLUMN IF NOT EXISTS main_place_id     TEXT,
  ADD COLUMN IF NOT EXISTS main_place_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'operator_tours'::regclass
       AND conname  = 'operator_tours_main_place_id_fkey'
  ) THEN
    ALTER TABLE operator_tours
      ADD CONSTRAINT operator_tours_main_place_id_fkey
      FOREIGN KEY (main_place_id) REFERENCES places(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'operator_tours'::regclass
       AND conname  = 'operator_tours_main_place_source_check'
  ) THEN
    ALTER TABLE operator_tours
      ADD CONSTRAINT operator_tours_main_place_source_check
      CHECK (main_place_source IS NULL OR main_place_source IN ('coords_equal', 'operator'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operator_tours_main_place
  ON operator_tours (main_place_id)
  WHERE main_place_id IS NOT NULL;

-- Кандидаты считаются подзапросом по самой строке тура, без сверки id двух
-- таблиц: связь ставится, только когда живое место в точке ровно одно, и
-- тогда скалярный подзапрос возвращает именно его.
UPDATE operator_tours t
   SET main_place_id = (
         SELECT p.id
           FROM places p
          WHERE p.lat = t.latitude
            AND p.lng = t.longitude
            AND p.is_visible = TRUE
            AND p.merged_into_id IS NULL
       ),
       main_place_source = 'coords_equal'
 WHERE t.main_place_id IS NULL
   AND t.deleted_at IS NULL
   AND t.latitude IS NOT NULL
   AND t.longitude IS NOT NULL
   AND (SELECT COUNT(*)
          FROM places p
         WHERE p.lat = t.latitude
           AND p.lng = t.longitude
           AND p.is_visible = TRUE
           AND p.merged_into_id IS NULL) = 1;

COMMENT ON COLUMN operator_tours.main_place_id IS
  'Главное место тура (places.id). NULL — не связано. Связь явная: точное совпадение координат с ровно одним живым местом (1286) или выбор оператора в кабинете; по близости и по имени не выводится (§4.1, §14).';
COMMENT ON COLUMN operator_tours.main_place_source IS
  'Откуда связь с главным местом: coords_equal — миграция 1286 по точному равенству координат; operator — выбрано оператором в кабинете.';

-- Rollback:
-- ALTER TABLE operator_tours DROP CONSTRAINT IF EXISTS operator_tours_main_place_source_check;
-- ALTER TABLE operator_tours DROP CONSTRAINT IF EXISTS operator_tours_main_place_id_fkey;
-- DROP INDEX IF EXISTS idx_operator_tours_main_place;
-- ALTER TABLE operator_tours DROP COLUMN IF EXISTS main_place_source;
-- ALTER TABLE operator_tours DROP COLUMN IF EXISTS main_place_id;
