-- 1019: расписание гида ссылается на живую бронь, а не на мёртвые таблицы.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- guide_schedule.tour_id (uuid) держал FK на legacy-таблицу туров, а
-- guide_schedule.booking_id (uuid) не держал ничего. Живые туры и брони —
-- operator_tours / operator_bookings — с bigint-ключами, поэтому каждое
-- соединение расписания с ними (`gs.tour_id = t.id`, `gs.booking_id = b.id`)
-- отвечало 42883 «operator does not exist: uuid = bigint»: экраны
-- «Расписание» и «Группы» гида не выполнялись НИКОГДА. Записать в эти
-- колонки осмысленное значение было невозможно: живого тура с uuid-ключом
-- не существует. Писатель расписания (POST) при этом всегда отвечал 409
-- «Конфликт» — он звал SQL-функцию check_schedule_conflicts, которой нет
-- в схеме, а отказ читал как «конфликт есть». Значит, строк с этими
-- колонками на проде быть не может, и снос их ничего не теряет.
--
-- ── Что теперь ────────────────────────────────────────────────────────────
-- guide_schedule — личный календарь гида: tour_date + start_time/end_time
-- (time, местное время, как ввёл гид). Запись может ссылаться на бронь,
-- на которую гида назначил оператор, — operator_booking_id (bigint, FK на
-- operator_bookings). Пишет её POST/PUT /api/guide/schedule с проверкой,
-- что бронь назначена именно этому гиду.

ALTER TABLE guide_schedule DROP CONSTRAINT IF EXISTS guide_schedule_tour_id_fkey;
DROP INDEX IF EXISTS idx_guide_schedule_booking_id;
ALTER TABLE guide_schedule DROP COLUMN IF EXISTS tour_id;
ALTER TABLE guide_schedule DROP COLUMN IF EXISTS booking_id;

ALTER TABLE guide_schedule
  ADD COLUMN IF NOT EXISTS operator_booking_id BIGINT REFERENCES operator_bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_guide_schedule_operator_booking
  ON guide_schedule (operator_booking_id)
  WHERE operator_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guide_schedule_guide_date
  ON guide_schedule (guide_id, tour_date);

COMMENT ON COLUMN guide_schedule.operator_booking_id IS
  'Бронь, на которую оператор назначил гида (operator_bookings.guide_partner_id = guide_id). NULL — личная запись гида.';
