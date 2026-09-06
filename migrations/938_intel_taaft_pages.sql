-- 938: taaft страницами. Решение владельца: «нам нужен taaft — там фичи и новинки».
--
-- ЗАМЕР (перепись с прода, режим кандидатов, 06.09). Ленты у них нет: /feed/ и
-- /rss/ отвечают HTML, newsletter.taaft.com — HTTP 403 на обоих адресах. Путь
-- записей — /ai/, и с этим префиксом все четыре страницы отдают по восемь:
--
--   /                 3391 якорь · слоганы инструментов
--   /new/             1378 якорей · ЦЕННИКИ И ДАТЫ вместо имён
--   /trending/         500 якорей · имена вперемешку со значками подборки
--   /period/today/    1082 якоря  · слоганы инструментов
--
-- Заводятся ДВЕ страницы, а не четыре:
--
--   /period/today/ — «что вышло сегодня», прямой ответ на «новинки»;
--   /trending/     — «что набирает ход», прямой ответ на «фичи».
--
-- Главная и /new/ не заводятся: главная — то же, что /period/today/, только
-- шире и медленнее (5,5 МБ против 1,7), а /new/ отдаёт тот же поток новинок,
-- что и /period/today/, но его карточки не несут имени в тексте ссылки. Два
-- источника об одном и том же — это удвоенный вес одной темы в дайджесте.
--
-- Имя записи у taaft живёт в АДРЕСЕ (/ai/<инструмент>), и когда текстом
-- ссылки оказывается ярлык (ценник, дата, значок места), разбор берёт имя
-- оттуда, а ярлык оставляет подписью. Правило узкое и детерминированное —
-- lib/services/intelligence/page-links.ts, сторож intel-page-source.

INSERT INTO intelligence_sources (url, source_type, domain, label, active, page_prefix) VALUES
  ('https://theresanaiforthat.com/period/today/', 'page', 'ai_tech', 'TAAFT — новинки дня', true, '/ai/'),
  ('https://theresanaiforthat.com/trending/',     'page', 'ai_tech', 'TAAFT — набирает ход', true, '/ai/')
ON CONFLICT (url) DO UPDATE
   SET source_type = EXCLUDED.source_type,
       domain      = EXCLUDED.domain,
       label       = EXCLUDED.label,
       active      = true,
       page_prefix = EXCLUDED.page_prefix,
       last_error  = NULL,
       fetch_error_count = 0,
       updated_at  = NOW();
