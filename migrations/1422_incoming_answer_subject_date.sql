-- 1422: ответ оператора кнопкой знает, на какую дату заявки он дан.
-- Created: 2026-11-11
--
-- План «после отказа» (слово владельца 11.11, «карт-бланш по плану
-- действуй»), этап 2а — тупик «Изменить дату».
--
-- До этой миграции ответ кнопкой (1334) был один на заявку, без даты. После
-- «Нет мест» турист в «Моей поездке» мог только ПРОСИТЬ оператора о другой
-- дате: любой ответ запирал смену даты (lib/requests/my-trip-date,
-- ANSWERED_SQL), а «Нет мест» статус заявки не меняет. Человек, которому
-- сказали «на эту дату мест нет», не мог сам выбрать свободную — и ответа
-- оператора на новую дату записать было некуда: строка ответа уже стояла.
--
-- Теперь:
--   - subject_date — дата заявки (source_data.date), на которую дан ответ.
--     TEXT, а не DATE: сравнивается с source_data->>'date' тем же выражением
--     (lib/requests/answer-date, LEAD_ANSWER_DATE_SQL), и приведение к дате в
--     JOIN статуса уронило бы 22008 весь ответ get_request_status на кривой
--     дате в jsonb;
--   - один ответ — на (предмет, партнёр, дата). «Нет мест» на 15.01 и ответ
--     на 20.01 после переноса — две строки; следующий адресат большой группы
--     (lib/leads/followup-scope) отвечает своей строкой, а не упирается в
--     ответ прежнего.
--
-- Заполнение точное: до этой правки дата заявки после любого ответа не
-- менялась (MY_TRIP_DATE_CHANGE_SQL ... AND NOT ANSWERED), значит текущая
-- дата лида — та, на которую ответили. Заявки без даты в ISO (подбор, письмо
-- со страницы оператора со свободным текстом) — NULL, как и все не-лиды.
--
-- Окно выката: старый контейнер пишет ответ с ON CONFLICT (subject_kind,
-- subject_id) и после этой миграции получит 42P10 — нажатие ответит «Не
-- удалось записать ответ», повтор после переключения пройдёт. Новый код
-- пишет ON CONFLICT без цели.

BEGIN;

ALTER TABLE partner_incoming_answers ADD COLUMN IF NOT EXISTS subject_date TEXT;

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_subject_date_check;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_subject_date_check
  CHECK (
    subject_date IS NULL
    OR (subject_kind = 'lead' AND subject_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  );

UPDATE partner_incoming_answers pa
   SET subject_date = l.source_data->>'date'
  FROM leads l
 WHERE pa.subject_kind = 'lead'
   AND pa.subject_id::text = l.id::text
   AND pa.subject_date IS NULL
   AND l.source_data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_subject_uidx;
ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_subject_date_key;
ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_subject_date_key
  UNIQUE NULLS NOT DISTINCT (subject_kind, subject_id, partner_id, subject_date);

COMMENT ON COLUMN partner_incoming_answers.subject_date IS
  'Дата заявки (source_data.date), на которую дан ответ; NULL — у заявки нет даты в ISO или это не заявка.';

COMMIT;

-- Rollback (вернуть один ответ на предмет можно, только удалив вторые):
-- BEGIN;
-- DELETE FROM partner_incoming_answers a USING partner_incoming_answers b
--  WHERE a.subject_kind = b.subject_kind AND a.subject_id = b.subject_id AND a.id > b.id;
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_subject_date_key;
-- ALTER TABLE partner_incoming_answers ADD CONSTRAINT partner_incoming_answers_subject_uidx UNIQUE (subject_kind, subject_id);
-- ALTER TABLE partner_incoming_answers DROP CONSTRAINT IF EXISTS partner_incoming_answers_subject_date_check;
-- ALTER TABLE partner_incoming_answers DROP COLUMN IF EXISTS subject_date;
-- COMMIT;
