-- 1449: входящее сообщение доводится до ответа и после перезапуска.
--
-- Задача #3433 п. 1, второй шаг; слово владельца 16.11 «Оба шага». Миграция
-- 1448 завела память о виденных апдейтах, но не знала, ОБРАБОТАН ли апдейт.
-- Отсюда два провала:
--   * MAX ждёт ответа вебхука, пока идёт обработка. Упал процесс посередине —
--     MAX присылает апдейт снова, а 1448 считает его повтором: сообщение
--     потеряно. До 1448 повтор после перезапуска обрабатывался.
--   * Telegram получает 200 до обработки и сам не повторяет: упал процесс —
--     сообщение потеряно и до, и после 1448.
--
-- Теперь у строки есть:
--   boot_id      — какой запуск процесса её взял;
--   processed_at — обработка закончилась (успехом или ошибкой: заново не
--                  исполняется то, что могло исполниться наполовину);
--   attempts     — сколько раз строку подхватывал другой запуск (один раз:
--                  сообщение, роняющее процесс, не роняет его по кругу);
--   payload      — сообщение Telegram до конца обработки, чтобы новый запуск
--                  мог его подобрать. Это текст человека (ПД): стирается при
--                  отметке «обработано», а не подобранное — через 15 минут
--                  (lib/chat/inbound-seen). Callback'и Telegram и MAX не
--                  хранятся: MAX повторяет сам, нажатия заново не исполняются.
--
-- Строки, записанные до этой миграции, обрабатывались прежним кодом без
-- отметки — им ставится processed_at = received_at, чтобы их повтор не
-- считался недоделанным.
--
-- Идемпотентна: IF NOT EXISTS; повторная отметка трогает только строки без
-- processed_at, а миграции идут до старта сервера.

ALTER TABLE chat_inbound_seen ADD COLUMN IF NOT EXISTS boot_id TEXT;
ALTER TABLE chat_inbound_seen ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE chat_inbound_seen ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_inbound_seen ADD COLUMN IF NOT EXISTS payload JSONB;

UPDATE chat_inbound_seen SET processed_at = received_at WHERE processed_at IS NULL;

-- Подбор недоделанного: только Telegram с сохранённым сообщением.
CREATE INDEX IF NOT EXISTS chat_inbound_seen_unprocessed_idx
  ON chat_inbound_seen (received_at)
  WHERE processed_at IS NULL AND payload IS NOT NULL;
