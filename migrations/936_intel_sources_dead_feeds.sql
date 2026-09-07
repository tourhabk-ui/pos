-- 936: ленты разведки — мёртвые отключить, живые включить.
--
-- ПОВОД. Watchdog каждые полчаса: «Intelligence Monitor — прогонов подряд без
-- результата, чаще всего: no_signals». Перепись с прода
-- (GET /api/cron/intel-feeds-census, 06.09) назвала виновных поимённо:
--
--   ai_tech          — 9 живых из 11;
--   competitors      — 0 из 2;
--   travel_industry  — 0 из 5.
--
-- Два домена молчали не потому, что новостей нет, а потому что у них не
-- осталось ни одной работающей ленты.
--
-- ПОЧЕМУ ЗАМЕНЫ ИМЕННО ЭТИ. Каждая проверена с ПРОДА тем же кодом, что читает
-- ленты (перепись, режим кандидатов, 06.09) — по восемь записей у каждой:
--
--   https://www.atorus.ru/news/rss.xml    АТОР: тот же источник, новый адрес
--   https://tourdom.ru/rss/               ТурДом
--   https://tass.ru/rss/v2.xml            ТАСС
--   https://kamchatka.aif.ru/rss/all.php  АиФ-Камчатка
--
-- Проверять с раннера GitHub было нельзя: в тот же час он отвечал по тем же
-- адресам иначе (kamgov 403 против 404 с прода, visitkamchatka 404 против
-- 200), потому что страны режут друг друга. Судить о ленте надо с той
-- машины, которая её читает.
--
-- ЧТО НЕ ДЕЛАЕМ. Не удаляем строки: `active = false` сохраняет улику — что
-- было настроено и почему снято. Мёртвый адрес завтра может ожить.

-- ── Отключаем мёртвые, с причиной в last_error ────────────────────────────
UPDATE intelligence_sources SET active = false,
       last_error = 'перепись 06.09 с прода: HTTP 404 (адрес сменился)', updated_at = NOW()
 WHERE url IN (
   'https://www.atorus.ru/rss/news.xml',
   'https://www.tourprom.ru/news/rss/',
   'https://www.kamgov.ru/news/rss',
   'https://www.anthropic.com/rss.xml'
 );

UPDATE intelligence_sources SET active = false,
       last_error = 'перепись 06.09 с прода: адрес не отвечает', updated_at = NOW()
 WHERE url IN ('https://ator.ru/rss.xml', 'https://rata-news.ru/feed/');

UPDATE intelligence_sources SET active = false,
       last_error = 'перепись 06.09 с прода: HTML вместо ленты', updated_at = NOW()
 WHERE url IN (
   'https://rustravelforum.com/rss',
   'https://visitkamchatka.ru/',
   'https://developer.nvidia.com/'
 );

-- ── Включаем живые ────────────────────────────────────────────────────────
-- Идемпотентно: повторный прогон не задваивает (url UNIQUE) и возвращает
-- строку в строй, если её отключали.
INSERT INTO intelligence_sources (url, source_type, domain, label, active) VALUES
  ('https://www.atorus.ru/news/rss.xml',   'rss', 'travel_industry', 'АТОР',           true),
  ('https://tourdom.ru/rss/',              'rss', 'travel_industry', 'ТурДом',         true),
  ('https://tass.ru/rss/v2.xml',           'rss', 'travel_industry', 'ТАСС',           true),
  -- Камчатская лента в competitors намеренно: домен смотрит за РЕГИОНОМ и
  -- конкурентами, а сайты конкурентов там читает не RSS, а скрейп
  -- (scrapeCompetitorPages). Без единой ленты домен отчитывался бы «не
  -- настроено ни одной», и это было бы правдой о настройке, но неправдой о
  -- работе.
  ('https://kamchatka.aif.ru/rss/all.php', 'rss', 'competitors',     'АиФ-Камчатка',   true)
ON CONFLICT (url) DO UPDATE
  SET active = true, domain = EXCLUDED.domain, label = EXCLUDED.label,
      last_error = NULL, fetch_error_count = 0, updated_at = NOW();

INSERT INTO _migrations (name)
VALUES ('936_intel_sources_dead_feeds.sql')
ON CONFLICT (name) DO NOTHING;
