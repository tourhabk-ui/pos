-- 942_agent_route_knowledge_search_text.sql
--
-- Поиск мест Кузьмича не работал НИКОГДА — три дефекта, и каждый прятал два
-- остальных.
--
-- 1. Колонка `search_text` в представлении `agent_route_knowledge` объявлена
--    `NULL::tsvector` — в обеих ветках UNION, с миграции 157 и во всех её
--    наследниках (160, 677, 711, 863, 869). Колонка с именем «текст для
--    поиска» не содержала текста для поиска.
--
-- 2. Запрос в `lib/kuzmich/core.ts` оборачивал её в `to_tsvector('russian',
--    search_text)`. Функции `to_tsvector(regconfig, tsvector)` не существует —
--    значит запрос падал 42883 на КАЖДОМ вызове, не иногда и не под нагрузкой.
--
-- 3. Отказ глотал пустой `catch { return ''; }`. Кузьмич получал пустой
--    контекст и отвечал про безопасность ПО ПАМЯТИ МОДЕЛИ, а не по нашей базе.
--
-- Порознь ни один не виден: колонка пуста — но запрос всё равно падает раньше;
-- запрос падает — но лог молчит; лог молчит — но ответ приходит связный.
-- Это ровно §4.0: место, где нельзя сказать «не знаю», заполняется словом
-- «хорошо».
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- Даёт колонке содержание, обещанное её именем: `search_text` собирается из
-- мастер-таблиц тем же составом полей, что и в миграции 104, где эта колонка
-- заполнялась в последний раз (title + description + location_type +
-- activity_type). Состав взят оттуда намеренно, а не придуман заново.
--
-- Текст VIEW — копия 869-й; изменены РОВНО две строки `NULL::tsvector`.
-- Порядок, имена и типы колонок сохранены: CREATE OR REPLACE VIEW иначе не
-- проходит, а INSTEAD OF триггеры (663) переживают замену только так.
--
-- Индексы: выражение в индексе обязано СОВПАДАТЬ с выражением в представлении
-- символ в символ, иначе планировщик его не возьмёт и всё выродится в seq scan
-- с построением tsvector на каждую строку. Поэтому оба списаны друг с друга.
-- CONCURRENTLY не используется намеренно: таблицы маленькие (места ~780 строк,
-- маршруты ~300), блокировка записи — миллисекунды, а вне транзакции миграция
-- потеряла бы атомарность с заменой представления.

CREATE INDEX IF NOT EXISTS idx_places_search_fts
  ON places
  USING GIN (to_tsvector('russian',
    COALESCE(name, '')::text || ' ' ||
    COALESCE(description, '')::text || ' ' ||
    COALESCE(location_type, '')::text || ' ' ||
    COALESCE(activity_type, '')::text));

CREATE INDEX IF NOT EXISTS idx_kamchatka_routes_search_fts
  ON kamchatka_routes
  USING GIN (to_tsvector('russian',
    COALESCE(title, '')::text || ' ' ||
    COALESCE(description, '')::text || ' ' ||
    COALESCE(activity_type, '')::text));

CREATE OR REPLACE VIEW agent_route_knowledge AS
  SELECT
    p.ark_id                          AS id,
    NULL::text                        AS route_dedupe_key,
    NULL::uuid                        AS route_id,
    p.category,
    p.name                            AS title,
    p.description,
    p.lat,
    p.lng,
    p.source_url,
    p.source_name,
    to_tsvector('russian',
      COALESCE(p.name, '')::text || ' ' ||
      COALESCE(p.description, '')::text || ' ' ||
      COALESCE(p.location_type, '')::text || ' ' ||
      COALESCE(p.activity_type, '')::text)  AS search_text,
    '{}'::jsonb                       AS payload,
    NULL::text                        AS source_hash,
    NULL::timestamptz                 AS source_updated_at,
    NULL::timestamptz                 AS last_synced_at,
    p.created_at,
    p.updated_at,
    p.is_visible,
    p.location_type,
    p.activity_type,
    NULL::text                        AS kuzmich_review,
    p.zone,
    'place'::text                     AS kind,
    p.search_count,
    p.embedding
  FROM places p
  WHERE p.merged_into_id IS NULL
UNION ALL
  SELECT
    COALESCE(r.ark_id, r.id)          AS id,
    r.dedupe_key                      AS route_dedupe_key,
    NULL::uuid                        AS route_id,
    r.category,
    r.title,
    r.description,
    r.lat,
    r.lng,
    r.source_url,
    r.source_name,
    to_tsvector('russian',
      COALESCE(r.title, '')::text || ' ' ||
      COALESCE(r.description, '')::text || ' ' ||
      COALESCE(r.activity_type, '')::text)  AS search_text,
    COALESCE(r.metadata, '{}'::jsonb) AS payload,
    NULL::text                        AS source_hash,
    NULL::timestamptz                 AS source_updated_at,
    NULL::timestamptz                 AS last_synced_at,
    r.created_at,
    r.updated_at,
    r.is_visible,
    NULL::character varying           AS location_type,
    r.activity_type,
    NULL::text                        AS kuzmich_review,
    r.zone,
    'route'::text                     AS kind,
    r.search_count,
    r.embedding
  FROM kamchatka_routes r
  WHERE r.merged_into_id IS NULL;

INSERT INTO _migrations (name)
VALUES ('942_agent_route_knowledge_search_text.sql')
ON CONFLICT (name) DO NOTHING;
