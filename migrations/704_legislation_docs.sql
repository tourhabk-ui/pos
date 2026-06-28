-- 704_legislation_docs.sql
-- Хранилище нормативки/законодательства для туристов (источник: Путешествуем.рф и др. официальные).
-- Принцип анти-галлюцинации: full_text — дословный скрейп оригинала (источник истины),
-- AI добавляет только summary + category (ярлык), но НЕ переписывает текст закона.
-- source_url хранится всегда — Кузьмич цитирует ссылку, не выдумывает норму.

CREATE TABLE IF NOT EXISTS legislation_docs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_url     TEXT NOT NULL,
  source         VARCHAR(100) NOT NULL DEFAULT 'Путешествуем.рф',
  title          TEXT NOT NULL,
  category       VARCHAR(40) NOT NULL DEFAULT 'other',
  summary        TEXT,
  full_text      TEXT,
  effective_date TEXT,
  parsed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_stale       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Уникальность по URL — повторный sync делает UPSERT, не дубли
CREATE UNIQUE INDEX IF NOT EXISTS legislation_docs_source_url_idx ON legislation_docs(source_url);
CREATE INDEX IF NOT EXISTS legislation_docs_category_idx ON legislation_docs(category);

-- Полнотекстовый поиск (русский) по заголовку + summary + тексту
CREATE INDEX IF NOT EXISTS legislation_docs_fts_idx ON legislation_docs
  USING GIN (to_tsvector('russian',
    coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(full_text,'')));
