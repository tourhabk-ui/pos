-- 1421: «Лагуна Экспедиция» — зима закрыта у пяти туров, где по тексту тура
-- зимой ход под вопросом.
-- Created: 2026-11-11
--
-- Слово владельца 11.11: «лагуна б» — на предложение «закрыть зиму миграцией
-- по оценке у туров 12, 13, 16, 17, 18, с декабря по апрель; даты закрываются,
-- а не удаляются, оператор может открыть их сам».
--
-- 1420 открыла 18 турам «Лагуны», сезон которых не назван ни в туре, ни в
-- календаре оператора, каждый день на год вперёд — и зиму тоже. Тексты этих
-- пяти (миграция 1339, сайт оператора на 26.10) зимой не подходят:
--   - «На край света (мыс Маячный)» и «Мыс Маячный + Халактырский пляж» — «на
--     внедорожнике по лесной тропе через сопки»; зимой у того же оператора на
--     Маячный идёт отдельный тур на снегоходе (1413, окно 13.11–10.04);
--   - «Высадка на Марс: экспедиция в каньон Опасный» — через Вилючинский
--     перевал и кальдеру Горелого к водопаду у Мутновского; в «что взять» —
--     крем SPF 50 и гамаши;
--   - «Облёт вулканов Мутновский и Горелый + Ходуткинские горячие источники» и
--     «Облёт Авачинской бухты и Авачинского вулкана + Тимоновские источники» —
--     «шапка (для экскурсий в осеннее время)», средство от насекомых, купальник;
--     о зиме ни слова.
-- Это оценка платформы, не слово оператора: поэтому даты не удаляются, а
-- закрываются, как стоп-продажа (`is_cancelled`, причина словами), и оператор
-- открывает их в кабинете одной кнопкой (POST/DELETE /api/operator/calendar/
-- block: дата с местами снова открыта).
--
-- Окно — 01.12.2026–30.04.2027 (весь горизонт 1420 кончается 11.11.2027).
--
-- Не трогается:
--   - дата с бронью или удержанием мест (тот же счёт занятости, что у
--     стоп-продажи, lib/bookings/occupancy): бронь на неё уже есть, закрыть её
--     значило бы оставить человека без тура;
--   - дата, которую оператор уже правил сам (updated_at позже создания больше
--     чем на минуту: триггер trigger_tour_availability_timestamp) — его
--     решение сильнее оценки; неизвестное время правки тоже считается правкой;
--   - уже закрытые и удалённые даты;
--   - остальные 13 туров без сезона и туры с сезоном.
--
-- Идемпотентно: повтор закрывать нечего — закрытые даты в отбор не входят.

BEGIN;

CREATE TEMP TABLE _lagw_tours (slug text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _lagw_tours (slug) VALUES
  ('lagexp-na-kraj-sveta-mys-mayachnyj'),
  ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh'),
  ('lagexp-kanon-opasnyj'),
  ('lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya'),
  ('lagexp-obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki');

DO $$
DECLARE
  v_reason CONSTANT text := 'Закрыто Ведаром: зимой тур по его описанию под вопросом (1421). Если тур ходит — откройте даты.';
  v_tours int;
  v_closed int;
  v_kept_booked int;
BEGIN
  SELECT COUNT(*) INTO v_tours
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _lagw_tours l ON l.slug = t.slug
   WHERE t.deleted_at IS NULL;

  -- Дата с бронью — открытой: счёт занятости тот же, что у стоп-продажи.
  SELECT COUNT(*) INTO v_kept_booked
    FROM tour_availability ta
    JOIN operator_tours t ON t.id = ta.operator_tour_id AND t.deleted_at IS NULL
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _lagw_tours l ON l.slug = t.slug
   WHERE ta.date BETWEEN DATE '2026-12-01' AND DATE '2027-04-30'
     AND ta.deleted_at IS NULL AND NOT COALESCE(ta.is_cancelled, FALSE)
     AND (COALESCE(ta.booked_slots, 0) > 0 OR (
       SELECT (COALESCE(SUM(b.participants), 0)
               + (SELECT COALESCE(SUM(h.seats), 0) FROM tour_seat_holds h
                   WHERE h.tour_id = ta.operator_tour_id AND h.hold_date = ta.date
                     AND h.released_at IS NULL))::int
         FROM operator_bookings b
        WHERE b.operator_tour_id = ta.operator_tour_id
          AND b.booking_status NOT IN ('cancelled', 'rejected')
          AND b.deleted_at IS NULL
          AND ta.date BETWEEN b.booking_date AND COALESCE(b.end_date, b.booking_date)
     ) > 0);

  WITH closed AS (
    UPDATE tour_availability ta
       SET is_cancelled = TRUE, cancellation_reason = v_reason, updated_at = NOW()
      FROM operator_tours t
      JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
      JOIN _lagw_tours l ON l.slug = t.slug
     WHERE t.id = ta.operator_tour_id AND t.deleted_at IS NULL
       AND ta.date BETWEEN DATE '2026-12-01' AND DATE '2027-04-30'
       AND ta.deleted_at IS NULL AND NOT COALESCE(ta.is_cancelled, FALSE)
       -- Оператор не правил дату: правка сдвигает updated_at триггером.
       AND ta.created_at IS NOT NULL AND ta.updated_at IS NOT NULL
       AND ta.updated_at <= ta.created_at + INTERVAL '1 minute'
       AND COALESCE(ta.booked_slots, 0) = 0
       AND (
         SELECT (COALESCE(SUM(b.participants), 0)
                 + (SELECT COALESCE(SUM(h.seats), 0) FROM tour_seat_holds h
                     WHERE h.tour_id = ta.operator_tour_id AND h.hold_date = ta.date
                       AND h.released_at IS NULL))::int
           FROM operator_bookings b
          WHERE b.operator_tour_id = ta.operator_tour_id
            AND b.booking_status NOT IN ('cancelled', 'rejected')
            AND b.deleted_at IS NULL
            AND ta.date BETWEEN b.booking_date AND COALESCE(b.end_date, b.booking_date)
       ) = 0
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_closed FROM closed;

  RAISE WARNING '[1421] «Лагуна Экспедиция», зима 01.12.2026–30.04.2027: туров из списка %, закрыто дат %, оставлено открытыми с бронью %',
    v_tours, v_closed, v_kept_booked;
  IF v_tours <> 5 THEN
    RAISE WARNING '[1421] из пяти туров списка найдено % — проверьте адреса', v_tours;
  END IF;
END $$;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE tour_availability
--    SET is_cancelled = FALSE, cancellation_reason = NULL, updated_at = NOW()
--  WHERE cancellation_reason = 'Закрыто Ведаром: зимой тур по его описанию под вопросом (1421). Если тур ходит — откройте даты.';
-- COMMIT;
