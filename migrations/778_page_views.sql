-- Migration 778: таблица page_views — счётчик посещаемости наконец пишет
--
-- PageViewTracker и /api/analytics/hit жили в коде с самого начала, но
-- таблицы page_views не создавала НИ ОДНА миграция: INSERT в эндпоинте
-- обёрнут в catch(() => {}) и молча глотал "relation does not exist",
-- а дневной дайджест через safe(..., 0) честно показывал ноль просмотров.
-- Классика «защита не в точке действия»: счётчик был, стока не было.
--
-- visitor_hash — суточный sha256(день+соль+ip+ua), сырые IP/UA не храним
-- (152-ФЗ); подробности в lib/analytics/visitor-hash.ts.

CREATE TABLE IF NOT EXISTS page_views (
  id BIGSERIAL PRIMARY KEY,
  path TEXT NOT NULL,
  referrer TEXT,
  visitor_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Если таблицу когда-то создали руками без колонки — доводим схему
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS visitor_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views (path);

INSERT INTO _migrations (name)
VALUES ('778_page_views.sql')
ON CONFLICT (name) DO NOTHING;
