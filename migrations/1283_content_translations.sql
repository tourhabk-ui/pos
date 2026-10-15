-- Migration 1283: машинный перевод публичных текстов на китайский (аудит 15.10,
-- находка CN-pages; Китай, шаг 7, вариант «в» — малый объём с честной
-- пометкой машинного перевода, решение главной сессии по карт-бланшу
-- владельца 15.10)
-- Created: 2026-10-15
--
-- Таблица, а не колонки title_zh / description_zh в operator_tours и places:
-- у перевода есть своё происхождение (каким путём модели, когда, вычитан ли
-- человеком) и свой срок годности. Колонка рядом с исходником этого не
-- держит — оператор правит описание, а китайский текст остаётся прежним и
-- выдаёт себя за перевод нового.
--
-- Устаревание видно по source_hash: SHA-256 нормализованного исходного поля
-- в тот момент, когда его переводили (считает lib/zh/translate, sourceHash).
-- При показе хэш пересчитывается от живого поля; не совпал — перевод
-- устарел, страница показывает русский текст с пометкой, а не старый
-- китайский.
--
--   entity_type — 'tour' (operator_tours) или 'place' (places);
--   entity_id   — id строки текстом: у туров число, у мест text-PK;
--   field       — имя поля исходника. Какие поля переводятся — список в
--                 коде (ZH_TOUR_FIELDS, ZH_PLACE_FIELDS), не здесь: цены,
--                 даты, телефоны, опасности и правила безопасности моделью
--                 не переводятся вовсе;
--   lang        — 'zh-CN' (язык раздела /zh, lib/zh/pages);
--   text        — перевод: у текстового поля строкой, у списка и программы —
--                 JSON-массивом той же длины, что исходник. Пустой строки как
--                 перевода быть не может (CHECK): отказ модели не пишется
--                 сюда вовсе и называется «не переведено» в ответе крона;
--   back_translation — обратный перевод на русский той же формы, для сверки
--                 владельцем по-русски. NULL — обратный перевод не получен;
--   model       — путь вызова (например 'ai-quality'), а не id модели:
--                 обёртки водопада модель не возвращают, и записать её значило
--                 бы записать догадку (§4.0; тот же приём у
--                 route_description_cache.model = 'ai-waterfall');
--   reviewed_by / reviewed_at — вычитка человеком. NULL — не вычитано, и
--                 страница пишет «机器翻译（未经人工校对）».
--
-- Ключ (entity_type, entity_id, field, lang) уникален: у поля один текущий
-- перевод, новый заменяет прежний (ON CONFLICT DO UPDATE в кроне
-- /api/cron/zh-translate).

CREATE TABLE IF NOT EXISTS content_translations (
  id               BIGSERIAL   PRIMARY KEY,
  entity_type      VARCHAR(16) NOT NULL,
  entity_id        TEXT        NOT NULL,
  field            VARCHAR(48) NOT NULL,
  lang             VARCHAR(16) NOT NULL,
  source_hash      CHAR(64)    NOT NULL,
  text             TEXT        NOT NULL,
  back_translation TEXT,
  model            VARCHAR(64) NOT NULL,
  translated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  CONSTRAINT content_translations_entity_check CHECK (entity_type IN ('tour', 'place')),
  CONSTRAINT content_translations_lang_check CHECK (lang IN ('zh-CN')),
  CONSTRAINT content_translations_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT content_translations_hash_check CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_translations_review_check CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT content_translations_key UNIQUE (entity_type, entity_id, field, lang)
);

-- Чтение страницы и sitemap — по сущности и языку.
CREATE INDEX IF NOT EXISTS idx_content_translations_entity
  ON content_translations (entity_type, lang, entity_id);

COMMENT ON TABLE content_translations IS
  'Машинный перевод публичных текстов (аудит 15.10, CN-pages). Устаревание — по source_hash; пустого перевода нет (CHECK); reviewed_* NULL — не вычитано человеком.';
