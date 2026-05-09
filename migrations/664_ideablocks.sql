-- 664_ideablocks.sql
-- Таблица IdeaBlocks от Blockify для RAG Кузьмича
-- Хранит структурированные знания о местах и маршрутах

CREATE TABLE IF NOT EXISTS ideablocks (
  id            TEXT        PRIMARY KEY,   -- ib_<sha256[:16]>
  source_type   VARCHAR(10) NOT NULL CHECK (source_type IN ('place', 'route', 'tour')),
  source_id     UUID,
  name          TEXT        NOT NULL,
  critical_question TEXT    NOT NULL,
  trusted_answer    TEXT    NOT NULL,
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  keywords      TEXT[]      NOT NULL DEFAULT '{}',
  entity_name   TEXT,
  entity_type   TEXT,
  search_text   TSVECTOR,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ideablocks_source
  ON ideablocks (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_ideablocks_search
  ON ideablocks USING GIN (search_text);

CREATE INDEX IF NOT EXISTS idx_ideablocks_tags
  ON ideablocks USING GIN (tags);

-- Автообновление search_text из полей блока
CREATE OR REPLACE FUNCTION ideablocks_search_update() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_text := to_tsvector('russian',
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.critical_question, '') || ' ' ||
    COALESCE(NEW.trusted_answer, '') || ' ' ||
    COALESCE(array_to_string(NEW.keywords, ' '), '')
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ideablocks_search_trigger ON ideablocks;
CREATE TRIGGER ideablocks_search_trigger
  BEFORE INSERT OR UPDATE ON ideablocks
  FOR EACH ROW EXECUTE FUNCTION ideablocks_search_update();
