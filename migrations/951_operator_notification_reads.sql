-- 951_operator_notification_reads.sql
--
-- «Прочитано» у уведомлений оператора хранится, а не живёт в useState.
--
-- Прогулка оператором 11.09 (#1801): кнопка «Прочитать все» и клик по
-- уведомлению меняли только состояние React — после перезагрузки страницы всё
-- снова непрочитано. Кнопка, которая ничего не сохраняет, — родня находки
-- #1785 про действия без мутации.
--
-- Почему отдельная таблица, а не колонка `read_at` у брони/отзыва: уведомление
-- — это ВЫВОД из строки (бронь, отмена, отзыв), а не сама строка. Отметка
-- «оператор это видел» принадлежит оператору, не брони: у одной брони может
-- быть несколько адресатов (оператор, позже — его сотрудники), и пометка
-- одного не должна переписывать чужую.
--
-- id уведомления — строка вида `b-123` / `r-45`, та же, что отдаёт API.
-- Хранится как TEXT намеренно: в ней закодирован и род источника, и его id,
-- а FK на две разные таблицы одной колонкой не поставить. Цена честная и
-- записана: мусор в этой колонке БД не поймает; ловит его тот единственный
-- роут, который сюда пишет.

CREATE TABLE IF NOT EXISTS operator_notification_reads (
  partner_id      UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  notification_id TEXT        NOT NULL,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partner_id, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_notification_reads_partner
  ON operator_notification_reads(partner_id, read_at DESC);

COMMENT ON TABLE operator_notification_reads IS
  'Отметки «прочитано» для уведомлений кабинета оператора (#1801). notification_id — id из ответа /api/hub/operator/notifications: b-<booking_id> | r-<review_id>.';
