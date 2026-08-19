-- 879. Проверка внешней поверхности сайтов операторов
--
-- Решение владельца 19.08 по issue #1275: платформа ручается за оператора, и
-- его сайт — часть этого ручательства. До сих пор мы не проверяли его ничем.
--
-- Что здесь МОЖНО и чего нельзя. Проверка — это обычные HTTPS-запросы к
-- публичным адресам: сертификат, заголовки, смешанный контент, раскрытие
-- версий, открытые служебные пути. Перебора паролей, фаззинга и эксплуатации
-- нет и не будет: это уже не оценка, а атака, и для неё нужно письменное
-- разрешение владельца сайта, а не решение владельца платформы.
--
-- Три состояния у КАЖДОЙ проверки (CLAUDE.md §4.0). Проверка, которая не
-- смогла выполниться, обязана сказать «не знаю», а не «хорошо»: сайт лежал,
-- имя не разрешилось, вышел таймаут — это не «безопасно».

CREATE TABLE IF NOT EXISTS operator_site_audits (
  id            BIGSERIAL PRIMARY KEY,
  partner_id    UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Адрес на момент прогона: website у партнёра меняется, а отчёт остаётся,
  -- и без снимка адреса он через месяц не значит ничего.
  site_url      TEXT NOT NULL,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Итог прогона. `unknown` — полноправный исход: сайт не ответил.
  verdict       TEXT NOT NULL DEFAULT 'unknown'
                CHECK (verdict IN ('ok', 'issues', 'unknown')),
  -- Разбор по проверкам: [{ id, outcome: ok|bad|unknown, severity, detail }]
  checks        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Счётчики для списка и графиков — считаются из checks при записи.
  bad_count     INT NOT NULL DEFAULT 0,
  unknown_count INT NOT NULL DEFAULT 0,
  -- Почему прогон не состоялся вовсе (DNS, таймаут, отказ соединения).
  failure       TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_site_audits_partner
  ON operator_site_audits (partner_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_site_audits_verdict
  ON operator_site_audits (verdict, checked_at DESC);

-- Согласие оператора. Пассивные проверки его не требуют — это то же, что
-- открыть сайт браузером. Но согласие всё равно записывается: оно понадобится
-- в разговоре с оператором и в любом расширении проверки вглубь.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS site_audit_consent TEXT NOT NULL DEFAULT 'unknown'
  CHECK (site_audit_consent IN ('unknown', 'granted', 'declined'));

COMMENT ON TABLE operator_site_audits IS
  'Внешняя поверхность сайта оператора: сертификат, заголовки, раскрытие. Без эксплуатации.';
COMMENT ON COLUMN partners.site_audit_consent IS
  'Согласие оператора на проверку сайта: unknown | granted | declined.';
