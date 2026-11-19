-- 1332: сырой User-Agent ИИ-краулеров (и YandexBot, Bingbot) для админки.
--
-- Слово владельца 24.10: строка в админке за последние 7 дней, чтобы сверить
-- счётчики краулеров. Людей и прочие UA не пишем. До этой миграции сырой
-- User-Agent не хранился вовсе — старые 7 дней задним числом не восстановить.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_crawler_ua (
  day         DATE NOT NULL,
  family      TEXT NOT NULL,
  user_agent  TEXT NOT NULL,
  path        TEXT,
  hits        INTEGER NOT NULL DEFAULT 1 CHECK (hits > 0),
  PRIMARY KEY (day, family, user_agent)
);

COMMENT ON TABLE ai_crawler_ua IS
  'Сырой User-Agent ИИ-краулера, YandexBot или Bingbot. Людей нет. Витрина — 7 дней.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS ai_crawler_ua;
-- COMMIT;
