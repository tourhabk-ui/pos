-- 937: источники-страницы. Anthropic главным, лента NVIDIA вместо главной.
--
-- ПОВОД. Решение владельца 06.09: «Anthropic должен быть главным и нам нужен
-- taaft — там фичи и новинки». Догадка владельца о способе публикации
-- («наверное там по другому публикуется через страницы») проверена с прода:
--
--   https://www.anthropic.com/news   HTTP 200, 471 КБ, HTML — НЕ лента
--   /rss.xml, /feed.xml, /news/rss.xml, /rss   HTTP 404 — все четыре
--
-- Лента, стоявшая в реестре с миграции 144, отключена в 936 как мёртвая.
-- Единственный путь к главному источнику — разбор страницы.
--
-- ЗАМЕР РАЗБОРА (перепись с прода, 06.09, режим кандидатов): на
-- anthropic.com/news из 113 якорей отобрано 3 записи, и все три настоящие —
-- «Previewing the Model Hardware Standard» (27.08), «How Claude's text
-- watermark works» (14.08), «Introducing Claude Opus 5» (24.07). Заводится по
-- этому замеру, а не по намерению.
--
-- ПРЕФИКС ОТБОРА. У страницы-ленты записи лежат под своим путём, и путь этот
-- не всегда совпадает с путём самой страницы. У Anthropic совпадает
-- (/news → /news/...), у taaft НЕТ: список новинок и карточки инструментов
-- живут по разным путям. Поэтому префикс — своя колонка, а не догадка из
-- адреса. NULL значит «путь самой страницы», как раньше.
--
-- TAAFT В ЭТУ МИГРАЦИЮ НЕ ВХОДИТ. Замер показал, почему: с префиксом «/»
-- разбор theresanaiforthat.com отдаёт не записи, а навигацию («Leaderboard»,
-- «Mini tools») и кусок их же шаблона. Заводить источник, который будет
-- кормить разведку мусором, нельзя — сначала замер префикса (следующий
-- прогон), потом строка в реестре.

ALTER TABLE intelligence_sources
  ADD COLUMN IF NOT EXISTS page_prefix TEXT;

COMMENT ON COLUMN intelligence_sources.page_prefix IS
  'Для source_type = page: путь, под которым лежат записи. NULL — путь самой страницы.';

-- ── Anthropic страницей ───────────────────────────────────────────────────
INSERT INTO intelligence_sources (url, source_type, domain, label, active, page_prefix) VALUES
  ('https://www.anthropic.com/news', 'page', 'ai_tech', 'Anthropic News', true, NULL)
ON CONFLICT (url) DO UPDATE
   SET source_type = EXCLUDED.source_type,
       domain      = EXCLUDED.domain,
       label       = EXCLUDED.label,
       active      = true,
       page_prefix = EXCLUDED.page_prefix,
       last_error  = NULL,
       fetch_error_count = 0,
       updated_at  = NOW();

-- ── NVIDIA: лента вместо главной ──────────────────────────────────────────
-- В реестре стояла просто https://developer.nvidia.com/ — она и не могла быть
-- лентой (936 отключила её как HTML). Настоящие адреса проверены с прода:
-- blogs.nvidia.com/feed/ (RSS, 8 записей) и developer.nvidia.com/blog/feed/
-- (Atom, 8 записей).
INSERT INTO intelligence_sources (url, source_type, domain, label, active) VALUES
  ('https://blogs.nvidia.com/feed/',        'rss', 'ai_tech', 'NVIDIA Blog',     true),
  ('https://developer.nvidia.com/blog/feed/', 'rss', 'ai_tech', 'NVIDIA Developer', true)
ON CONFLICT (url) DO UPDATE
   SET active = true, last_error = NULL, fetch_error_count = 0, updated_at = NOW();
