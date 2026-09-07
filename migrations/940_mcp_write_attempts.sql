-- 940: журнал попыток записи через публичный MCP.
--
-- Публичный MCP по решению владельца работает без авторизации — манифест так
-- и объявляет. Единственным тормозом на записи стоял счётчик в памяти
-- процесса (lib/rate-limit.ts, `new Map`), и это не тормоз: он обнуляется на
-- каждом рестарте контейнера и не существует между инстансами. Анонимная
-- запись персональных данных удерживалась ограничением, которого фактически
-- не было. Внешний аудит 07.09 назвал это точно.
--
-- Считать надо там же, где данные переживают рестарт, — в базе. Отдельная
-- таблица, а не колонка в leads: считать надо и ОТКАЗАННЫЕ попытки, у которых
-- лида не возникает, иначе поток отказов сам себя не ограничивает.
--
-- ПЕРСОНАЛЬНЫХ ДАННЫХ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Ни телефона, ни имени, ни
-- адреса: только необратимые отпечатки с секретной солью. Иначе защита от
-- утечки ПД сама стала бы вторым местом их хранения — с тем же адресом
-- клиента, который мы и пытаемся не разглашать.

CREATE TABLE IF NOT EXISTS mcp_write_attempts (
  id          BIGSERIAL PRIMARY KEY,
  -- sha256(соль + адрес + user-agent). Не адрес: у IPv4 всё пространство
  -- перебирается за секунды, и голый хеш адресом и остаётся.
  client_key  CHAR(64) NOT NULL,
  tool        VARCHAR(64) NOT NULL,
  -- sha256(соль + нормализованный телефон). Нужен, чтобы поймать поток
  -- заявок на один номер с разных адресов; сам номер отсюда не восстановить.
  phone_hash  CHAR(64),
  -- allowed | rate_limited | quarantined | no_consent | unknown
  outcome     VARCHAR(16) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Счёт всегда идёт по окну «за последние сутки»: индексы под это и заточены.
CREATE INDEX IF NOT EXISTS idx_mcp_write_attempts_client
  ON mcp_write_attempts (client_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_write_attempts_phone
  ON mcp_write_attempts (phone_hash, created_at DESC)
  WHERE phone_hash IS NOT NULL;

-- Для разбора всплеска: что именно отвергали и когда.
CREATE INDEX IF NOT EXISTS idx_mcp_write_attempts_outcome
  ON mcp_write_attempts (outcome, created_at DESC);
