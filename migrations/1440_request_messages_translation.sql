-- 1440: машинный перевод сообщения переписки — рядом с исходником.
--
-- Слово владельца 13.11: «когда иностранцы обращаются к оператору, то нужно
-- для оператора переводить на русский, а ответ оператора должен быть наоборот
-- на языке обратившегося»; о прежнем правиле «текст переписки в модели не
-- уходит» — «переписать».
--
-- Перевод делается один раз, при отправке сообщения, и хранится в той же
-- строке: живёт и удаляется вместе с исходником, повторно не переводится.
-- Направление колонкой не записано — его называет автор: слова клиента
-- (author = guest) переведены на русский для адресата, слова адресата
-- (author = owner) — на язык клиента.
--
-- NULL — перевода нет: он не был нужен (обе стороны читают по-русски) либо
-- модель не справилась. Пустая строка переводом не бывает (CHECK).
--
-- В переводе — те же слова людей, что в body: отдельного правила хранения у
-- него нет. В модель исходник уходит с маской переписки: телефоны, почта,
-- ссылки, ники и имена — плейсхолдерами (lib/requests/chat-translation);
-- подпись таблицы ниже говорит это вместо прежнего «в промпты моделей не
-- уходит» (1350, 1439).
--
-- Пишет lib/requests/request-chat-service.ts, читает страница заявки
-- (/api/requests/chat).

BEGIN;

ALTER TABLE request_messages
  ADD COLUMN IF NOT EXISTS translation       TEXT        NULL,
  -- когда сделан перевод и каким путём водопада
  ADD COLUMN IF NOT EXISTS translated_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS translation_model VARCHAR(40) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_messages_translation_not_blank') THEN
    ALTER TABLE request_messages
      ADD CONSTRAINT request_messages_translation_not_blank
      CHECK (translation IS NULL OR char_length(btrim(translation)) BETWEEN 1 AND 8000);
  END IF;
  -- Перевод и его отметка — вместе: перевод без времени и пути и отметка без
  -- перевода одинаково значат испорченную строку.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_messages_translation_stamped') THEN
    ALTER TABLE request_messages
      ADD CONSTRAINT request_messages_translation_stamped
      CHECK ((translation IS NULL) = (translated_at IS NULL) AND (translation IS NULL) = (translation_model IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN request_messages.translation IS
  'Машинный перевод body: слова клиента (author guest) — на русский, слова адресата (author owner) — на язык клиента. NULL — перевод не был нужен или не получен (1440)';

COMMENT ON TABLE request_messages IS
  'Переписка адресата заявки (владелец жилья, туроператор, гид, перевозчик, прокат) и клиента (1349, 1350). Цель — заявка на жильё или лид, ровно одна. author owner — сторона адресата. Текст — слова людей. Слова адресата по ключу новой заявки читает и ИИ-агент, оставивший заявку (get_request_status, partner_messages, 1439); слова клиента в ответы инструментов не уходят. В модель текст уходит только на перевод между клиентом и адресатом, с маской телефонов, почты, ссылок и имён (1440).';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE request_messages
--   DROP CONSTRAINT IF EXISTS request_messages_translation_stamped,
--   DROP CONSTRAINT IF EXISTS request_messages_translation_not_blank,
--   DROP COLUMN IF EXISTS translation_model,
--   DROP COLUMN IF EXISTS translated_at,
--   DROP COLUMN IF EXISTS translation;
-- COMMIT;
