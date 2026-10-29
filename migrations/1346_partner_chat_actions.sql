-- 1346: действие кнопкой из чата кабинета (MAX, Telegram) — бронь и заявка
-- своего тура в два шага, как на сайте (план «гид в чате», шаги 6 и 7).
--
-- Номер 1346: писалась как 1345 (max + 1 после слияния с main: 1340 — клипы
-- Курильского, 1341 и 1342 заняты раньше этой ветки); 29.10 ветка влилась
-- следом за 1345_ugms_forecasts (#2836), и два файла делили номер — CI на main
-- краснел и держал выкат. Перенумерована прямым пушем сразу после влития #2837,
-- до применения на проде (запись выката на тот момент — 3159edb, до обоих).
--
-- Гид со своими турами нажимает под бронью «Подтвердить» (`bk:c:<id>`). До
-- нажатия «Да» бронь не меняется: между вопросом и ответом действие живёт
-- здесь, а кнопка «Да» несёт только id строки (`oc:y:<uuid>`). Право нажатия
-- даёт чат кабинета и человек, подключивший его (partners.max_owner_user_id /
-- telegram_owner_user_id, 1336), а не знание uuid (lib/bookings/chat-owner-action).
--
-- Статусы и их производители (lib/bookings/chat-owner-action, правило 10.09):
--   awaiting_reason — «Отклонить»: ждём причину одним сообщением чата (её
--                     получит турист); только для action = 'cancel';
--   ready           — вопрос «Да / Не надо» показан;
--   running         — «Да» захвачено одним атомарным UPDATE ... WHERE
--                     status = 'ready': второе нажатие (повтор MAX, двойной
--                     клик) строку уже не захватит и смены статуса не повторит;
--   done            — правило смены статуса отработало, итог в outcome;
--   refused         — «Да» нажато, а бронь не этого кабинета, переход нельзя
--                     или запись не удалась: итог и причина в outcome;
--   cancelled       — «Не надо» или «отмена» вместо причины;
--   superseded      — в том же чате нажата следующая кнопка действия.
-- «Истекло» — не статус, а вычисление expires_at <= NOW() (15 минут).
--
-- subject_kind = 'lead' — заявка своего тура (шаг 7: «Связался»,
-- «Договорились», «Отказ», правило changeLeadStatus).
--
-- Чего в строке нет намеренно: имени, телефона и почты туриста и user_id
-- нажавшего. Строка — журнал действия: кто (partner_id, канал, чат), над чем
-- (subject), что (action, reason — текст продавца для туриста), когда
-- (created_at, used_at), итог (outcome). Удаление аккаунта стирает строки его
-- чатов (lib/account/erase). Причина отклонения — о туристе: удаление аккаунта
-- туриста, чья это бронь, заменяет её той же подписью, что cancellation_reason
-- брони (subject_id — текст без внешнего ключа, шаг находит строки по его броням).
--
-- Идемпотентна: IF NOT EXISTS у таблицы и индексов. Без BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS partner_chat_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel      VARCHAR(16) NOT NULL CHECK (channel IN ('max', 'telegram')),
  chat_id      BIGINT NOT NULL,
  subject_kind VARCHAR(16) NOT NULL CHECK (subject_kind IN ('booking', 'lead')),
  -- id брони (bigint строкой) или заявки (uuid): форма — по роду ниже.
  subject_id   TEXT NOT NULL,
  action       VARCHAR(16) NOT NULL,
  -- Причина отклонения брони — её получает турист в письме (≤ 255, как у двери сайта).
  reason       VARCHAR(255),
  status       VARCHAR(16) NOT NULL
               CHECK (status IN ('awaiting_reason', 'ready', 'running', 'done', 'refused', 'cancelled', 'superseded')),
  outcome      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  CONSTRAINT pca_subject_form CHECK (
    (subject_kind = 'booking' AND subject_id ~ '^[0-9]{1,18}$')
    OR (subject_kind = 'lead' AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  CONSTRAINT pca_action_of_subject CHECK (
    (subject_kind = 'booking' AND action IN ('confirm', 'cancel', 'complete', 'no_show'))
    OR (subject_kind = 'lead' AND action IN ('contacted', 'qualified', 'converted', 'lost'))
  ),
  -- Причину ждёт только отклонение брони.
  CONSTRAINT pca_reason_wait CHECK (status <> 'awaiting_reason' OR action = 'cancel'),
  -- Отклонение без причины не показывается вопросом и не исполняется.
  CONSTRAINT pca_cancel_has_reason CHECK (
    action <> 'cancel'
    OR status IN ('awaiting_reason', 'cancelled', 'superseded')
    OR btrim(COALESCE(reason, '')) <> ''
  ),
  CONSTRAINT pca_used_when_pressed CHECK ((used_at IS NOT NULL) = (status IN ('running', 'done', 'refused'))),
  CONSTRAINT pca_outcome_final CHECK ((outcome IS NOT NULL) = (status IN ('done', 'refused')))
);

-- Одно действующее действие на чат: следующая кнопка заменяет прежнее, и
-- следующее сообщение чата — причина только одного отклонения.
CREATE UNIQUE INDEX IF NOT EXISTS pca_one_active_per_chat
  ON partner_chat_actions (channel, chat_id) WHERE status IN ('awaiting_reason', 'ready');
CREATE INDEX IF NOT EXISTS pca_partner_created
  ON partner_chat_actions (partner_id, created_at DESC);
