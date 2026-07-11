-- Migration 742: верификация операторов по официальному реестру
-- visitkamchatka.ru/registry/ (issue #368)
--
-- Задача: сверять наших операторов (partners) с официальным реестром
-- туроператоров Камчатки. Нужны две вещи:
--   1. Снимок реестра (official_registry_operators) — источник истины +
--      лид-лист для acquisition (операторы из реестра, которых у нас нет).
--   2. Результат сверки на профиле оператора (partners.registry_*) —
--      флаг «в официальном реестре» + метрика расхождений.
--
-- Реестр наполняется скриптом scripts/scrape-registry-visitkamchatka.js,
-- сверка — сервисом lib/services/operator-registry.service.ts.
--
-- ВАЖНО: портал местами протухший (даты бронирования 2022), поэтому храним
-- registry_date и scraped_at — актуальность записи проверяется по ним.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

-- ── 1. Результат сверки на профиле оператора ─────────────────────────────────

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS registry_status     VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS registry_number     VARCHAR(120),
  ADD COLUMN IF NOT EXISTS registry_source_url TEXT,
  ADD COLUMN IF NOT EXISTS registry_checked_at TIMESTAMPTZ;

-- unknown   — сверка ещё не проводилась
-- verified  — найден в реестре (по ИНН/ОГРН или названию)
-- not_found — в реестре не найден
-- mismatch  — найден, но данные расходятся (ИНН/ОГРН не совпал либо статус «исключён»)
ALTER TABLE partners
  DROP CONSTRAINT IF EXISTS partners_registry_status_check;
ALTER TABLE partners
  ADD CONSTRAINT partners_registry_status_check
  CHECK (registry_status IN ('unknown', 'verified', 'not_found', 'mismatch'));

CREATE INDEX IF NOT EXISTS idx_partners_registry_status
  ON partners (registry_status);

-- ── 2. Снимок официального реестра ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS official_registry_operators (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  name_normalized   TEXT NOT NULL,               -- для матчинга и дедупликации
  inn               VARCHAR(20),
  ogrn              VARCHAR(20),
  registry_number   VARCHAR(120),                -- номер РТО / реестровый номер
  region            VARCHAR(160),
  registry_status   VARCHAR(80),                 -- статус в реестре: действующий / исключён
  contacts          JSONB,                       -- {phone, email, website, address}
  source_url        TEXT,
  registry_date     DATE,                         -- дата записи в реестре (проверка актуальности)
  matched_partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  match_method      VARCHAR(20),                 -- inn / ogrn / name / null
  raw               JSONB,                       -- сырые распарсенные поля
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scraped_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Дедупликация по нормализованному названию (ON CONFLICT target для upsert)
CREATE UNIQUE INDEX IF NOT EXISTS uq_registry_operators_name_norm
  ON official_registry_operators (name_normalized);

CREATE INDEX IF NOT EXISTS idx_registry_operators_inn
  ON official_registry_operators (inn) WHERE inn IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registry_operators_matched
  ON official_registry_operators (matched_partner_id);

COMMIT;
