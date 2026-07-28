-- Migration 782: счётчик начинает видеть ПОВЕДЕНИЕ, а не только факт захода
--
-- До этого в page_views лежали четыре поля: путь, реферер, суточный хэш, время.
-- По ним нельзя ответить ни на один вопрос, который на самом деле задают:
-- откуда человек пришёл ВНУТРИ сайта, сколько пробыл на странице, где ушёл,
-- какой путь заканчивается тупиком. Витрина показывала «975 просмотров /» и
-- ничего про то, что человек делал дальше.
--
-- Что добавляется и почему именно так:
--   session_id — случайный идентификатор ИЗ sessionStorage браузера. Живёт до
--     закрытия вкладки, ни с личностью, ни с аккаунтом не связан, между днями
--     не переносится. Он нужен ровно для того, чтобы выстроить переходы одного
--     визита в порядке. Длинного профиля посетителя платформа не строит by
--     design (152-ФЗ) — см. lib/analytics/visitor-hash.ts.
--   from_path — предыдущий путь В ЭТОМ ЖЕ визите. Это ребро карты переходов:
--     пара (from_path, path) с количеством и есть «куда люди идут с главной».
--   dwell_ms — сколько миллисекунд страница была видима. Проставляется вторым
--     запросом при уходе со страницы (sendBeacon), поэтому колонка nullable:
--     NULL значит «человек ещё на странице или браузер не успел досказать»,
--     и это честнее, чем ноль.
--   is_bot — краулер, опознанный по User-Agent. НЕ выбрасываем строку, а
--     помечаем: доля не-людей — сама по себе величина, которую надо видеть
--     (в источниках уже засветился aisearchindex.space). Выбросить молча
--     значило бы снова считать вслепую.
--   is_not_found — заход на несуществующий адрес. Это ошибка поведения, а не
--     просто просмотр: страница 404 в топе означает битую ссылку где-то у нас
--     или в чужой выдаче.

ALTER TABLE page_views ADD COLUMN IF NOT EXISTS session_id   TEXT;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS from_path    TEXT;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS dwell_ms     INTEGER;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS is_bot       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS is_not_found BOOLEAN NOT NULL DEFAULT FALSE;

-- Порядок событий внутри визита: по нему строятся переходы, глубина и выходы.
CREATE INDEX IF NOT EXISTS idx_page_views_session
  ON page_views (session_id, created_at)
  WHERE session_id IS NOT NULL;

-- Рёбра карты переходов: агрегат GROUP BY (from_path, path) за период.
CREATE INDEX IF NOT EXISTS idx_page_views_edge
  ON page_views (from_path, path)
  WHERE from_path IS NOT NULL;

-- Людские цифры считаются с отсечкой ботов — индекс под этот фильтр.
CREATE INDEX IF NOT EXISTS idx_page_views_human
  ON page_views (created_at)
  WHERE is_bot = FALSE;

INSERT INTO _migrations (name)
VALUES ('782_page_views_behavior.sql')
ON CONFLICT (name) DO NOTHING;
