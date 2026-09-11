-- 956: удалить демо-оператора «Рога и Копыта»
--
-- Решение владельца 11.09.2026: «Рога и Копыта удалить».
--
-- Это заглушка, попавшая на прод вместе с демо-данными. Она успела стоить
-- дорого: карточка сплава по Быстрой месяцами показывала её как продавца
-- (806), кнопка «Написать» открывала диалог с ней (815), а 807 спрятал её
-- туры, но саму запись оставил. Удаление закрывает след.
--
-- ── Почему это НЕ «DELETE FROM partners WHERE name = ...» ─────────────────
--
-- На `partners` ссылается порядка тридцати таблиц, на `operator_tours` —
-- восемнадцать, и далеко не все с `ON DELETE CASCADE`. В частности
-- `operator_bookings.operator_tour_id` объявлен БЕЗ `ON DELETE` (040:127), то
-- есть NO ACTION: удаление тура, на котором висит бронь, отвечает 23503 и
-- роняет миграцию целиком.
--
-- А упавшая миграция на этом проекте — не разовая неудача. `start.js` катит
-- миграции при КАЖДОМ деплое: 800 и 806 падали 15 и 12 раз подряд и стоили
-- трёх дней (разбор — 825). Прямой DELETE здесь имеет реальный шанс заклинить
-- деплой навсегда, и шанс тем выше, чем меньше мы знаем о проде.
--
-- Отсюда форма: миграция не может ни уронить деплой, ни удалить лишнего.
--
-- ── Два предохранителя, и они разные ──────────────────────────────────────
--
-- 1. БРОНИ — проверяются ЗАРАНЕЕ и отменяют всю работу. Это не техническое
--    препятствие, а смысловое: бронь на демо-туре означает, что заглушкой
--    кто-то реально пользовался, и тогда удалять нечего — надо разбираться.
--    Молча снести такое нельзя даже при технической возможности.
--
-- 2. ЧУЖИЕ ССЫЛКИ — спрашиваются у самой базы. Перечислять таблицы руками
--    значит завести список, который разойдётся с базой при первой же новой
--    таблице, и вдобавок угадывать имена колонок (`tour_id` или
--    `operator_tour_id` — по-разному в разных). Поэтому обслуживающие строки
--    демо-туров находятся через `pg_constraint`: кто ссылается и какой
--    колонкой, знает тот, кто ссылку держит.
--
--    Убираются только ссылки, которые РЕАЛЬНО мешают: `NO ACTION` и
--    `RESTRICT`. `CASCADE` и `SET NULL` справляются сами, и трогать их —
--    лишняя работа с лишним риском.
--
--    Радиус поражения ограничен по построению: удаляются только строки,
--    указывающие на туры ЭТОГО партнёра, и только после того, как проверка
--    выше доказала, что коммерческой деятельности на них нет.
--
-- Поверх обоих предохранителей стоит перехват `foreign_key_violation` — на
-- случай, которого мы не предусмотрели (ссылка на самого партнёра, а не на
-- его туры: на `partners` смотрит ещё около тридцати таблиц).
--
-- Перехват — не глушение (§4.0). Пустой `catch` превратил бы поломку в
-- «данных нет»; здесь в лог деплоя уходит и SQLSTATE, и текст отказа, и что
-- именно осталось неудалённым. Разница между «удалили» и «не смогли» обязана
-- быть видна словами.
--
-- ── Что НЕ делается здесь ─────────────────────────────────────────────────
--
-- Учётная запись в `users` с тем же именем не трогается. Демо-имя жило в двух
-- местах сразу — в `partners` и в `users` (чат берёт имя оттуда, см. 815), —
-- но `users` держит около сорока чужих таблиц, и среди них брони, SOS-события
-- и журналы. Удалять человека, чтобы убрать вывеску, — несоразмерно. 815 уже
-- переименовал ту запись, что стояла за настоящим партнёром; остальное —
-- отдельное решение с отдельной проверкой.
--
-- Идемпотентна: второй прогон не находит партнёра и выходит с уведомлением.

-- Таблицы, строка в которых означает коммерческую деятельность, а не
-- оформление тура. Одна такая строка отменяет всю работу: заглушка, которой
-- кто-то бронировал, заглушкой уже не является.
DO $$
DECLARE
  COMMERCE    CONSTANT text[] := ARRAY['operator_bookings', 'agent_bookings', 'channel_orders'];
  v_partner_ids  uuid[];
  v_tour_ids     bigint[];
  v_commerce     bigint := 0;
  v_found        bigint := 0;
  v_rec          record;
  v_attached     integer := 0;
  v_tours_gone   integer := 0;
  v_partners_gone integer := 0;
BEGIN
  -- Матч по имени. Шаблон узкий и заведомо не задевает живых партнёров:
  -- «Рога и Копыта» — контора Остапа Бендера, реального оператора с таким
  -- именем на Камчатке нет. Слоги двух настоящих партнёров исключены явно —
  -- дешёвая страховка на случай, если демо-именем когда-то назвали живую
  -- запись.
  SELECT array_agg(id) INTO v_partner_ids
    FROM partners
   WHERE name ILIKE '%рога%копыт%'
     AND COALESCE(slug, '') NOT IN (
       'kamchatka-rafting', 'fishingkam', 'kamchatskaya-rybalka',
       'rybalka-po-kamchatski', 'yana-splavy'
     );

  IF v_partner_ids IS NULL THEN
    RAISE NOTICE '953 demo-partner-purge: партнёра с именем «Рога и Копыта» нет — удалять нечего';
    RETURN;
  END IF;

  SELECT array_agg(id) INTO v_tour_ids
    FROM operator_tours
   WHERE operator_id = ANY(v_partner_ids);

  -- Проверка коммерции. Имя колонки спрашиваем у базы, а не угадываем: в этих
  -- трёх таблицах ссылка называется по-разному (operator_tour_id / tour_id).
  IF v_tour_ids IS NOT NULL THEN
    FOR v_rec IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN unnest(c.conkey) AS k(attnum) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND c.confrelid = 'operator_tours'::regclass
         AND array_length(c.conkey, 1) = 1
         AND c.conrelid::regclass::text = ANY(COMMERCE)
    LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE %I = ANY($1)', v_rec.tbl, v_rec.col)
        INTO v_found USING v_tour_ids;
      v_commerce := v_commerce + v_found;
    END LOOP;
  END IF;

  IF v_commerce > 0 THEN
    RAISE NOTICE
      '953 demo-partner-purge: ОТКАЗ. На турах демо-оператора % записей о бронях или заказах — это не заглушка, а используемая запись. Ничего не удалено, нужен разбор человеком.',
      v_commerce;
    RETURN;
  END IF;

  BEGIN
    IF v_tour_ids IS NOT NULL THEN
      -- Обслуживающие строки: расписание, опции, метки, правила цен и прочее,
      -- что живёт только вместе с туром. Берём ровно те ссылки, что мешают
      -- удалению (NO ACTION / RESTRICT), и ровно на эти туры.
      FOR v_rec IN
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
          FROM pg_constraint c
          JOIN unnest(c.conkey) AS k(attnum) ON TRUE
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.contype = 'f'
           AND c.confrelid = 'operator_tours'::regclass
           AND array_length(c.conkey, 1) = 1
           AND c.confdeltype IN ('a', 'r')
           AND NOT (c.conrelid::regclass::text = ANY(COMMERCE))
      LOOP
        EXECUTE format('DELETE FROM %I WHERE %I = ANY($1)', v_rec.tbl, v_rec.col)
          USING v_tour_ids;
        GET DIAGNOSTICS v_found = ROW_COUNT;
        v_attached := v_attached + v_found;
      END LOOP;

      DELETE FROM operator_tours WHERE id = ANY(v_tour_ids);
      GET DIAGNOSTICS v_tours_gone = ROW_COUNT;
    END IF;

    DELETE FROM partners WHERE id = ANY(v_partner_ids);
    GET DIAGNOSTICS v_partners_gone = ROW_COUNT;

    RAISE NOTICE '953 demo-partner-purge: удалено партнёров %, их туров %, обслуживающих строк %',
      v_partners_gone, v_tours_gone, v_attached;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE
      '953 demo-partner-purge: ОТКАЗ 23503, на записи висит чужая ссылка. Ничего не удалено. Подробности базы: %',
      SQLERRM;
  END;
END $$;
