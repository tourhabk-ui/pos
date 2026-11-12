-- Migration 1430: отметка «взял» в очереди менеджера (план «после отказа», этап 3б)
-- Created: 2026-11-12
--
-- До этого дня случаи, где человеку нужен звонок или замена, приходили
-- менеджеру тремя разными сообщениями в два мессенджера — и больше нигде не
-- лежали: недоставленный отказ оператора (письмо с телефоном в MAX), «Не могу»
-- перевозчика и прокатчика и «Занято» хозяина жилья (строка в рабочий чат
-- Telegram). Списка не было, и не было отметки, что случай кто-то взял: два
-- человека могли позвонить одному клиенту, а могли не позвонить оба.
--
-- Сама очередь не хранится: её собирают запросы из того, что уже записано
-- (answer_notices, lead_activity_log.partner_answered, stay_requests.owner_answer —
-- lib/manager-queue/queue.ts). Копия разошлась бы с источником: сообщение
-- дошло, заявку вернули в работу — а строка очереди осталась бы.
-- Здесь — только отметка: кто и когда взял случай.
--
-- subject_kind и subject_id:
--   answer_notice   — номер строки answer_notices: отказ туроператора или гида
--                     (кнопкой в чате или с причиной на сайте), не дошедший до человека;
--   vehicle_decline — номер записи lead_activity_log.partner_answered с ответом
--                     «Не могу» перевозчика или прокатчика;
--   stay_busy       — uuid заявки на жильё с ответом хозяина «занято».
-- Отметка одна на случай (первичный ключ): второй менеджер увидит, кто взял.
-- Внешних ключей на предмет нет — он в трёх разных таблицах; строку без
-- предмета очередь не показывает. taken_by — аккаунт администратора; удалили
-- аккаунт — отметка остаётся без имени.
--
-- Идемпотентна: IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS manager_queue_takes (
  subject_kind TEXT        NOT NULL,
  subject_id   TEXT        NOT NULL,
  taken_by     UUID        NULL REFERENCES users(id) ON DELETE SET NULL,
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  via          TEXT        NOT NULL DEFAULT 'site',
  PRIMARY KEY (subject_kind, subject_id),
  CONSTRAINT mqt_kind_check CHECK (subject_kind IN ('answer_notice', 'vehicle_decline', 'stay_busy')),
  CONSTRAINT mqt_via_check CHECK (via IN ('site', 'max')),
  CONSTRAINT mqt_subject_form CHECK (
    (subject_kind IN ('answer_notice', 'vehicle_decline') AND subject_id ~ '^[0-9]{1,18}$')
    OR (subject_kind = 'stay_busy'
        AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
);

COMMENT ON TABLE manager_queue_takes IS
  'Отметка «взял» в очереди менеджера: кто и когда взял случай после отказа. Сама очередь собирается запросами (lib/manager-queue/queue.ts).';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS manager_queue_takes;
-- COMMIT;
