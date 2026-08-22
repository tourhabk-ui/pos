-- 902_guide_schema_reconcile.sql
--
-- Кабинет гида был расколот между ДВУМЯ объявлениями одних и тех же таблиц.
--
-- lib/database/schema.sql держал `guide_schedule` и `guide_earnings` дважды,
-- с разными колонками. Из-за IF NOT EXISTS применяется первое; второе не
-- применяется никогда — но читается как правда тем, кто пишет код. И код
-- разошёлся ровно пополам:
--
--   по ПЕРВОМУ объявлению  — /api/guide/earnings, /api/guide/groups
--                            (tour_date, payment_status, schedule_id)
--   по ВТОРОМУ, призрачному — /api/guide/schedule, /api/guide/map,
--                            getGuideStats (title, location, status, date)
--
-- То есть половина кабинета гида обращается к колонкам, которых в объявленной
-- схеме нет. Обнаружено 22.08.2026 переписью: удаление призрака сняло глушение
-- со сторожей `schema-usage` и `sql-phantom-columns`, и они показали двенадцать
-- обращений к несуществующим колонкам.
--
-- Миграция сводит таблицы к ОБЪЕДИНЕНИЮ колонок: обе половины кода получают
-- то, что используют. NOT NULL не ставится нигде — в существующих строках
-- значения взять неоткуда, а выдумывать их нельзя.
--
-- ЧЕГО ЭТА МИГРАЦИЯ НЕ ЧИНИТ (осознанно):
--   * `start_time` объявлена как TIME в первом варианте и подразумевается
--     TIMESTAMPTZ во втором. Это одна колонка с двумя несовместимыми типами;
--     менять тип вслепую нельзя — сначала нужна боевая форма таблицы
--     (GET /api/cron/schema-audit).
--   * `guide_id` ссылается на users(id) в первом варианте и на partners(id)
--     во втором. Это расхождение СМЫСЛА, а не формы, и решается тем же
--     ответом аудита.

ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS title         TEXT;
ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS booking_id    UUID;
ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS location_name TEXT;
ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS location      JSONB;
ALTER TABLE guide_schedule ADD COLUMN IF NOT EXISTS notes         TEXT;

ALTER TABLE guide_earnings ADD COLUMN IF NOT EXISTS status            VARCHAR(20) DEFAULT 'pending';
ALTER TABLE guide_earnings ADD COLUMN IF NOT EXISTS date              DATE;
ALTER TABLE guide_earnings ADD COLUMN IF NOT EXISTS booking_id        UUID;
ALTER TABLE guide_earnings ADD COLUMN IF NOT EXISTS payment_method    VARCHAR(50);
ALTER TABLE guide_earnings ADD COLUMN IF NOT EXISTS payment_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_guide_earnings_status ON guide_earnings(status);
CREATE INDEX IF NOT EXISTS idx_guide_schedule_booking_id ON guide_schedule(booking_id);
