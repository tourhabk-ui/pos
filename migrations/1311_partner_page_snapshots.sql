-- 1311: снимки страниц сайтов партнёров — наблюдение за изменениями
--       (слово владельца 22.10: «нам нужно проверять сайты партнеров на
--       изменение»).
-- Created: 2026-10-22
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Туры партнёров у нас собраны с их сайтов: у туров «Края Вулканов» (1176) и
-- «Местечка Камчатка» (1217) записан source_url, туры «Камчатской рыбалки»
-- сверены с её сайтом без адресов страниц (1106). Партнёр поменял у себя цену, даты или снял тур — наша карточка стала
-- неправдой, и заметить это было нечем: ночная проверка сайтов операторов
-- (879) смотрит безопасность и с прошлым разом не сравнивает. На вопросы
-- «что делать при изменении» и «кого проверять» владелец ответил: сообщать
-- ему, проверять всех партнёров с сайтом.
--
-- ── Что здесь ─────────────────────────────────────────────────────────────
--
-- Одна строка — одно чтение страницы раз в сутки (GET /api/cron/partner-site-
-- watch, шаг в cron-operator-site-audit.yml). Исход — один из четырёх:
-- ok (прочитали), gone (404/410 — страницы нет), failed (не открылась),
-- robots (robots.txt сайта нам запретил — не читали). Сравнивается видимый
-- текст страницы (lib/partners/site-watch.ts): text_hash у каждого удачного
-- чтения, сам текст — только когда он изменился или читается впервые, чтобы
-- таблица не росла копиями одного и того же.
--
-- Персональных данных здесь нет: страницы публичные, это витрина партнёра.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_page_snapshots (
  id          BIGSERIAL   PRIMARY KEY,
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome     TEXT        NOT NULL CHECK (outcome IN ('ok', 'gone', 'failed', 'robots')),
  http_status INTEGER,
  text_hash   TEXT,
  text        TEXT,
  -- Что изменилось против прошлого удачного чтения: {"removed": [...], "added": [...]}.
  diff        JSONB,
  -- Что было решено по истории: baseline / same / changed / gone / back / failing / quiet.
  event       TEXT        NOT NULL,
  failure     TEXT,
  CHECK (outcome <> 'ok' OR text_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_partner_page_snapshots_url_checked
  ON partner_page_snapshots (url, checked_at DESC);

COMMENT ON TABLE partner_page_snapshots IS
  'Чтения страниц сайтов партнёров раз в сутки (1311): исход, хэш видимого текста, разница с прошлым разом. Пишет /api/cron/partner-site-watch.';

COMMIT;
