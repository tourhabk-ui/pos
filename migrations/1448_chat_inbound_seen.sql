-- 1448: входящие апдейты Telegram и MAX — память о виденном переживает перезапуск.
--
-- Задача #3433 п. 1; слово владельца 16.11 «Оба шага» (защита от повторов в
-- базе, затем сохранение сообщения до ответа). До этого повтор апдейта
-- отсекался только памятью процесса (lib/telegram/update-dedup,
-- lib/max/update-dedup): после перезапуска список пуст, и повтор, присланный
-- Telegram или MAX, давал второй ответ человеку и вторую запись в CRM. Нажатия
-- кнопок MAX (callback_id) не отсекались вовсе.
--
-- Строка — только ключ апдейта: источник и его номер (update_id Telegram, mid
-- сообщения MAX, callback_id нажатия). Текста, имени и номера чата здесь нет.
-- hits считает доставки: 1 — первая, больше — повтор. Строки старше суток
-- удаляет следующая запись (lib/chat/inbound-seen).
--
-- Идемпотентна: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS chat_inbound_seen (
  source      TEXT NOT NULL CHECK (source IN ('telegram', 'max_message', 'max_callback')),
  update_key  TEXT NOT NULL CHECK (char_length(update_key) BETWEEN 1 AND 200),
  hits        INTEGER NOT NULL DEFAULT 1,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, update_key)
);

CREATE INDEX IF NOT EXISTS chat_inbound_seen_received_idx ON chat_inbound_seen (received_at);
