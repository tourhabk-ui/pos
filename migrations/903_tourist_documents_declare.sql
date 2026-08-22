-- 903_tourist_documents_declare.sql
--
-- Таблица `tourist_documents` работала на проде и НЕ была объявлена ни в одном
-- файле схемы: она числилась в замороженном списке `KNOWN_UNDECLARED`
-- (tests/unit/schema-coverage.test.ts) — тридцать таблиц, чью форму вывести
-- неоткуда, и потому ошибка в колонке доживает до прода.
--
-- Объявление собрано по ЖИВОМУ коду, который с таблицей работает:
-- app/api/tourist/documents (INSERT/SELECT) и lib/auth/tourist-helpers
-- (getExpiringDocuments, markDocumentReminderSent). Ни одной колонки сверх
-- того, что код действительно использует, не выдумано.
--
-- IF NOT EXISTS: на проде это no-op, там таблица уже есть со своей формой.
-- Смысл миграции — чтобы ЧИСТЫЙ инстанс поднимался с этой таблицей, а сторожа
-- схемы могли судить о ней по файлам, а не по памяти.
--
-- В документах туриста лежат ПД (паспорт, номер, страна выдачи). Никаких
-- индексов по номеру документа здесь нет намеренно: искать людей по номеру
-- паспорта платформа не должна.

CREATE TABLE IF NOT EXISTS tourist_documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Ссылается на tourist_profiles(id), но ВНЕШНЕГО КЛЮЧА здесь нет: сама
  -- tourist_profiles тоже не объявлена ни одним файлом схемы (тот же список
  -- KNOWN_UNDECLARED). Объявить связь на несуществующую таблицу значит уронить
  -- сборку чистой базы — а это ровно та беда, которую миграция и лечит.
  -- Ключ добавится, когда родительская таблица получит своё объявление.
  tourist_id        UUID NOT NULL,
  document_type     VARCHAR(50) NOT NULL,
  document_number   TEXT,
  issuing_country   VARCHAR(100),
  issuing_authority TEXT,
  issue_date        DATE,
  expiry_date       DATE,
  file_url          TEXT,
  file_name         TEXT,
  file_size         BIGINT,
  notes             TEXT,
  -- Отметка о напоминании: без неё туристу придёт одно и то же письмо
  -- каждый день до самого истечения срока.
  reminder_sent     BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tourist_documents_tourist ON tourist_documents(tourist_id);
-- Крон напоминаний выбирает по сроку и по отметке — индекс ровно под него.
CREATE INDEX IF NOT EXISTS idx_tourist_documents_expiry
  ON tourist_documents(expiry_date) WHERE reminder_sent = FALSE;
