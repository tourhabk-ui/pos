-- 1287: история Кузьмича в Telegram — из chat_sessions в tg_conversations
--
-- Аудит 15.10, находка TG-BRAIN. Канонический вебхук Telegram
-- (/api/telegram/webhook) до этого дня отвечал туристу своей копией
-- Кузьмича и вёл историю разговора в chat_sessions: одна строка на чат,
-- session_id = 'tg_<chat_id>', messages — JSON-массив последних 20 реплик
-- {role, content}. С правкой TG-BRAIN он отвечает общим мозгом
-- lib/kuzmich/core (aiChat), а тот читает историю из tg_conversations
-- (chat_id, mode = 'tourist') — как второй вход того же бота.
--
-- Без переноса разговор оборвался бы на выкате: турист, спросивший вчера про
-- Мутновский, сегодня говорил бы с Кузьмичом, не помнящим ни вопроса, ни
-- ответа, а эвристика лида («номер после подборки туров») не нашла бы
-- интересов в пустой истории.
--
-- Что переносится: реплики user/assistant с непустым текстом из строк
-- chat_sessions вида 'tg_<число>' — так их писал только этот вебхук. Своего
-- времени у реплики в chat_sessions нет, есть updated_at строки — время
-- последней записи. Реплики раскладываются от него назад по секунде: порядок
-- сохраняется, и все они старше любой реплики, которую запишет новый код.
--
-- chat_sessions не чистится: это копия, а не переезд. Удалить старые строки —
-- отдельное решение (срок хранения), не побочный эффект переноса.
--
-- IDEMPOTENT: реплика не вставляется, если в tg_conversations уже есть та же
-- (chat_id, mode, role, content, created_at) — повторный прогон ничего не
-- добавит. Без BEGIN/COMMIT: транзакцию даёт раннер миграций.

INSERT INTO tg_conversations (chat_id, mode, role, content, created_at, platform)
SELECT src.chat_id, 'tourist', src.role, src.content, src.created_at, 'telegram'
FROM (
  SELECT
    -- CASE, а не голое приведение: порядок проверок в WHERE не обещан, а
    -- строка с чужим session_id не должна ронять перенос на 22P02.
    CASE WHEN cs.session_id ~ '^tg_-?[0-9]{1,18}$'
         THEN substring(cs.session_id FROM 4)::bigint END              AS chat_id,
    m.value->>'role'                                                  AS role,
    m.value->>'content'                                               AS content,
    cs.updated_at
      - make_interval(secs => (jsonb_array_length(cs.messages) - m.ord)::double precision)
                                                                      AS created_at
  FROM chat_sessions cs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(cs.messages) = 'array' THEN cs.messages ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS m(value, ord)
  WHERE cs.session_id ~ '^tg_-?[0-9]{1,18}$'
    AND cs.updated_at IS NOT NULL
    AND jsonb_typeof(m.value) = 'object'
) src
WHERE src.chat_id IS NOT NULL
  AND src.role IN ('user', 'assistant')
  AND COALESCE(btrim(src.content), '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM tg_conversations t
     WHERE t.chat_id = src.chat_id
       AND t.mode = 'tourist'
       AND t.role = src.role
       AND t.content = src.content
       AND t.created_at = src.created_at
  );
