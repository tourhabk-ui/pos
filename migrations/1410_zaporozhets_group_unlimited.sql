-- 1410: группа не ограничена у всех туров гида andrey-zaporozhets — слово владельца 08.11.
--
-- ── Основание ─────────────────────────────────────────────────────────────
--
-- Гид 29.10 (миграция 1342) про Курильское озеро: «количество человек не
-- ограничено, но должно быть кратно 4. У нас это в целом обычная практика.
-- Если больше одной группы собирается можно нанять еще машины для перевозки
-- нашей большой группы.» Тогда признак «группа не ограничена» поставили
-- только трём турам, о которых он говорил прямо.
--
-- Владелец 08.11, разбор заявки на 24 человека (туры «Горелый» и «Каньон
-- Опасный» отвечали «свободно 4 из 4, вас 24»): гид говорил, что для группы
-- больше машины он найдёт ещё машины. На вопрос «распространить „группа не
-- ограничена“ на все его туры?» — «Да, на все его туры».
--
-- ── Что меняется ──────────────────────────────────────────────────────────
--
-- 1. operator_tours.group_size_unlimited = TRUE у всех живых туров гида, где
--    стоит FALSE. Только FALSE → TRUE: снятый человеком признак этой миграцией
--    второй раз не ставится — она уже записана в _migrations.
-- 2. Слова гида «группа не больше четырёх» в описании, кратком описании и
--    примечании к цене заменяются его же формулой 1342: по четыре человека в
--    машине, для большой группы гид нанимает ещё машины. Только там, где стоит
--    текст миграций 1338/1342/1356: правка человека поверх него не трогается.
-- 3. Места — как в 1342, вариант (г): потолок одной заявки 4 → 12 (форма
--    платформы больше двенадцати не примет при любом числе), строки календаря
--    4 → 12 только на датах без броней. Это не вместимость гида, а снятие
--    ограничения платформы до её же потолка; группу больше заявки гид
--    подтверждает сам (заявка на группу сверх мест уходит ему запросом).
-- 4. Карточка гида: «группы не больше четырёх человек (на Курильское озеро —
--    по четыре в машине…)» → «по четыре человека в машине, число машин гид не
--    ограничивает».
--
-- Бухта Русская не трогается: там своё число (до 10 в лодке, 1342), признак
-- уже стоит.
--
-- Идемпотентна: каждая правка — по тексту, который она заменяет, и по
-- значению, которое меняет.

DO $$
DECLARE
  v_n   int;
  v_gid uuid;
  v_cnt int;
  v_desc_old  constant text := 'Авторский тур гида Андрея Запорожца: группа не больше четырёх человек, гид забирает с адреса.';
  v_desc_new  constant text := 'Авторский тур гида Андрея Запорожца: в машине — четыре человека, число машин гид не ограничивает (для большой группы нанимает ещё), гид забирает с адреса.';
  v_desc2_old constant text := 'Авторский тур гида Андрея Запорожца: группа не больше четырёх человек.';
  v_desc2_new constant text := 'Авторский тур гида Андрея Запорожца: в машине — четыре человека, число машин гид не ограничивает (для большой группы нанимает ещё).';
  v_note_old  constant text := 'Цена за человека по прайсу гида на 26.10.2026; группа не больше 4 человек.';
  v_note_new  constant text := 'Цена за человека по прайсу гида на 26.10.2026. Группа — по четыре человека в машине: для большой группы гид нанимает ещё машины (со слов гида 29.10, на все его туры — слово владельца 08.11). Одна заявка на сайте — до 12 человек.';
BEGIN
  SELECT count(*) INTO v_n FROM partners WHERE slug = 'andrey-zaporozhets' AND category = 'guide';
  IF v_n <> 1 THEN
    RAISE WARNING '[1410] карточка гида andrey-zaporozhets не найдена (или не одна: %) — группа не тронута', v_n;
    RETURN;
  END IF;
  SELECT id INTO v_gid FROM partners WHERE slug = 'andrey-zaporozhets' AND category = 'guide';

  -- ── 1. Признак ─────────────────────────────────────────────────────────
  UPDATE operator_tours SET group_size_unlimited = TRUE
   WHERE operator_id = v_gid AND deleted_at IS NULL AND group_size_unlimited = FALSE;

  -- ── 2. Слова о группе ──────────────────────────────────────────────────
  UPDATE operator_tours SET description = replace(description, v_desc_old, v_desc_new)
   WHERE operator_id = v_gid AND deleted_at IS NULL AND position(v_desc_old IN description) > 0;
  UPDATE operator_tours SET description = replace(description, v_desc2_old, v_desc2_new)
   WHERE operator_id = v_gid AND deleted_at IS NULL AND position(v_desc2_old IN description) > 0;
  UPDATE operator_tours SET short_description = replace(short_description, '. Группа до 4 человек.', '. По четыре человека в машине.')
   WHERE operator_id = v_gid AND deleted_at IS NULL AND position('. Группа до 4 человек.' IN short_description) > 0;
  UPDATE operator_tours SET short_description = replace(short_description, ', группа до 4 человек.', ', по четыре человека в машине.')
   WHERE operator_id = v_gid AND deleted_at IS NULL AND position(', группа до 4 человек.' IN short_description) > 0;
  UPDATE operator_tours SET price_note = replace(price_note, v_note_old, v_note_new)
   WHERE operator_id = v_gid AND deleted_at IS NULL AND position(v_note_old IN price_note) > 0;

  -- ── 3. Места: потолок заявки и календарь (вариант (г) 1342) ────────────
  UPDATE operator_tours SET max_participants = 12
   WHERE operator_id = v_gid AND deleted_at IS NULL AND max_participants = 4;
  UPDATE tour_availability ta SET available_slots = 12, updated_at = NOW()
    FROM operator_tours t
   WHERE t.id::text = ta.operator_tour_id::text AND t.operator_id = v_gid AND t.deleted_at IS NULL
     AND t.max_participants = 12
     AND ta.available_slots = 4 AND COALESCE(ta.booked_slots, 0) = 0
     AND ta.deleted_at IS NULL AND COALESCE(ta.is_cancelled, FALSE) = FALSE
     AND NOT EXISTS (
       SELECT 1 FROM operator_bookings b
        WHERE b.operator_tour_id = ta.operator_tour_id AND b.deleted_at IS NULL
          AND b.booking_status NOT IN ('cancelled', 'rejected')
          AND ta.date BETWEEN b.booking_date AND COALESCE(b.end_date, b.booking_date));
  SELECT count(*) INTO v_cnt
    FROM tour_availability ta JOIN operator_tours t ON t.id::text = ta.operator_tour_id::text
   WHERE t.operator_id = v_gid AND t.deleted_at IS NULL
     AND ta.deleted_at IS NULL AND ta.available_slots = 4;
  IF v_cnt > 0 THEN
    RAISE WARNING '[1410] у туров гида % дат(ы) остались на 4 местах (на дату есть бронь или её правил человек) — проверьте вручную', v_cnt;
  END IF;

  -- ── 4. Карточка гида ───────────────────────────────────────────────────
  UPDATE partners SET description = replace(description,
           'группы не больше четырёх человек (на Курильское озеро — по четыре в машине, число машин гид не ограничивает)',
           'по четыре человека в машине, число машин гид не ограничивает (для большой группы нанимает ещё)')
   WHERE id = v_gid
     AND position('группы не больше четырёх человек (на Курильское озеро — по четыре в машине, число машин гид не ограничивает)' IN description) > 0;
END $$;
