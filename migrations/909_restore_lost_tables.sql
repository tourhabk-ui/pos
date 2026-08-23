-- Migration 909: вернуть таблицы, которых на проде нет, а код в них ходит.
-- Партия 2 ремонта (партия 1 — миграции 906 и 907).
--
-- ФАКТ (перепись /api/cron/schema-drift, прод, 23.08.2026 00:55 UTC):
-- 415 файлов миграций, все записаны применёнными, 26 их действий на базе
-- отсутствуют — 7 таблиц и 19 колонок. Из семи таблиц ШЕСТЬ читает или
-- пишет живой код: это не мёртвые объявления, а эндпоинты, которые могут
-- ТОЛЬКО падать, и падают молча столько, сколько существуют.
--
-- ═══ ПОЧЕМУ ФАЙЛЫ НЕ ЛЕГЛИ — ПРИЧИНА НАЙДЕНА, А НЕ УГАДАНА ═══
--
-- `02_support_tables.sql` и `064_sales_tracking.sql` написаны на синтаксисе
-- MySQL. Внутри CREATE TABLE у них стоит
--
--     INDEX idx_status (status),
--     INDEX idx_articles_search ON knowledge_base_articles USING GIN(...)
--
-- PostgreSQL такого не принимает: индекс объявляется отдельным оператором
-- CREATE INDEX. Оба файла не могли выполниться НИКОГДА — ни на проде, ни на
-- чистой базе. Каждый деплой честно откатывал их и честно записывал
-- применёнными (дефект трекинга, задача #58).
--
-- Отсюда важное для реестра: восемь таблиц поддержки, внесённых 22.08 в
-- список «отсутствуют сознательно», отсутствуют не потому, что их удалили за
-- ненадобностью, — их никогда не существовало. Решение владельца «поддержка
-- не нужна» от этого не меняется, но причина теперь известна.
--
-- `knowledge_base_articles` объявлена тем же файлом 02, однако к поддержке
-- отношения не имеет: её читают база знаний ИИ (`/api/ai/knowledge-base`) и
-- `rag.service`. Поэтому она восстанавливается, а не списывается.
--
-- ═══ ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ ═══
--
-- `reference_tours` и `composite_bookings` (миграция 081) сюда НЕ входят,
-- хотя тоже пропали. Их мало вернуть: код, который к ним ходит, сломан
-- отдельно от схемы. `/api/reference-tours` при записи спрашивает
-- `SELECT id FROM operators WHERE user_id = $1` — таблицы `operators` нет
-- нигде, ни в миграциях, ни в мёртвой schema.sql, — и передаёт туда
-- `parseInt(payload.userId)` от UUID. `/api/planner/compose` вставляет
-- `tourist_id = 0` с комментарием «будет заполнено, когда турист забронирует»
-- — то есть коду нужно состояние «пока не знаю», а схема 081 требует
-- NOT NULL REFERENCES users(id). Восстановить таблицу и оставить это значило
-- бы отчитаться о починке, не починив: эндпоинты продолжили бы падать, но уже
-- по другой причине. Разбирается отдельной правкой, где чинится и код.
--
-- `agent_core_memory` тоже не восстанавливается: к ней НЕТ ни одного
-- обращения из кода. Заводить таблицу, в которую никто не пишет, — плодить
-- схему. В список «отсутствуют сознательно» она при этом не вносится: такое
-- решение принимает владелец, а не миграция. Остаётся видимой в переписи.
--
-- ═══ ТИПЫ ВЗЯТЫ ПО ФАКТУ, А НЕ ИЗ СТАРЫХ ФАЙЛОВ ═══
--
-- `booking_logs.booking_id` объявлялся в 019 как UUID REFERENCES bookings(id).
-- Здесь он BIGINT REFERENCES operator_bookings(id): броня живёт в
-- `operator_bookings`, её id — bigint, и писатель (`logStatusChange` в
-- lib/bookings/booking.service.ts) передаёт именно его. Ссылаться на
-- `bookings` нельзя ещё и потому, что род этого отношения на боевой базе не
-- установлен, а внешнего ключа на представление не бывает.

-- ── 1. База знаний ИИ ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_base_articles (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    content TEXT NOT NULL,
    content_search TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('russian', COALESCE(title, '') || ' ' || COALESCE(content, ''))
    ) STORED,
    category VARCHAR(100),
    tags TEXT[] DEFAULT '{}',
    author VARCHAR(255),
    views INTEGER DEFAULT 0 CHECK (views >= 0),
    helpful INTEGER DEFAULT 0 CHECK (helpful >= 0),
    unhelpful INTEGER DEFAULT 0 CHECK (unhelpful >= 0),
    is_published BOOLEAN DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_articles_category     ON knowledge_base_articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_is_published ON knowledge_base_articles(is_published);
CREATE INDEX IF NOT EXISTS idx_articles_created_at   ON knowledge_base_articles(created_at);
CREATE INDEX IF NOT EXISTS idx_articles_search       ON knowledge_base_articles USING GIN(content_search);

-- ── 2. Журнал переходов статуса брони ───────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id BIGINT NOT NULL REFERENCES operator_bookings(id) ON DELETE CASCADE,
    from_status VARCHAR(30) NOT NULL,
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_logs_booking_id ON booking_logs(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_logs_created_at ON booking_logs(created_at);

-- ── 3. Рассылка операторам (решение владельца 23.08.2026: восстановить) ──
CREATE TABLE IF NOT EXISTS sales_campaigns (
    id SERIAL PRIMARY KEY,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    batch_size INT NOT NULL,
    sent_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    interested_count INT DEFAULT 0,
    signed_count INT DEFAULT 0,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_outreach_log (
    id SERIAL PRIMARY KEY,
    campaign_id INT REFERENCES sales_campaigns(id) ON DELETE SET NULL,
    operator_telegram VARCHAR(255) UNIQUE NOT NULL,
    operator_name VARCHAR(255) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    response_text TEXT,
    response_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_status_log ON sales_outreach_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_telegram   ON sales_outreach_log(operator_telegram);
CREATE INDEX IF NOT EXISTS idx_campaigns_status    ON sales_campaigns(status, started_at DESC);

-- ── 4. Колонки operator_signups из того же файла 064 ─────────────────────
-- Сама таблица на проде есть (её завёл не 064), а три колонки — нет.
ALTER TABLE operator_signups ADD COLUMN IF NOT EXISTS first_tour_created_at TIMESTAMP;
ALTER TABLE operator_signups ADD COLUMN IF NOT EXISTS first_booking_at      TIMESTAMP;
ALTER TABLE operator_signups ADD COLUMN IF NOT EXISTS status                VARCHAR(50) DEFAULT 'new';

COMMENT ON TABLE knowledge_base_articles IS 'База знаний ИИ. Восстановлена миграцией 909: файл 02 написан на синтаксисе MySQL и не мог выполниться.';
COMMENT ON TABLE booking_logs IS 'Переходы статуса брони. Восстановлена миграцией 909; ключ ведёт на operator_bookings, а не на bookings.';
COMMENT ON TABLE sales_campaigns IS 'Кампании рассылки операторам. Восстановлена миграцией 909 по решению владельца 23.08.2026.';
