-- Migration 712: справочник природных парков — из хардкода в БД
--
-- Проблема: 4 парка были захардкожены в двух местах (PARK_MAP в
-- app/api/parks/[slug]/route.ts и PARK_NAMES в app/park/[slug]/page.tsx).
-- Добавление парка или правка телефона МЧС требовали деплоя кода.
--
-- search_term — паттерн для связи с маршрутами: kamchatka_routes.park_name
-- заполнялся импортом из visitkamchatka.ru свободным текстом («Природный
-- парк "Налычево"», «Налычевский парк» и т.п.), поэтому связь через ILIKE.
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

CREATE TABLE IF NOT EXISTS parks (
  id           BIGSERIAL PRIMARY KEY,
  slug         VARCHAR(64)  NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  description  TEXT,
  zone         VARCHAR(64),
  mchs_phone   VARCHAR(32),
  permit_url   TEXT,
  search_term  VARCHAR(128) NOT NULL,
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO parks (slug, display_name, description, zone, mchs_phone, permit_url, search_term) VALUES
  (
    'nalychevo',
    'Природный парк «Налычево»',
    'Один из самых посещаемых природных парков Камчатки. Термальные источники, вулканы Авачинской группы, маршруты любой сложности.',
    'avachinsky',
    '+7 (4152) 23-53-62',
    'https://nalychevo.ru',
    'Налычево'
  ),
  (
    'bystrinskiy',
    'Природный парк «Быстринский»',
    'Самый большой природный парк Камчатки. Центральная Камчатка, долина реки Быстрой, медведи, нетронутая тайга.',
    'northern',
    '+7 (4152) 23-53-62',
    NULL,
    'Быстринск'
  ),
  (
    'klyuchevskoy',
    'Природный парк «Ключевской»',
    'Кластер действующих вулканов — Ключевская Сопка (4750 м), Безымянный, Толбачик. Требует специальной подготовки и регистрации.',
    'northern',
    '+7 (41541) 2-10-33',
    NULL,
    'Ключевск'
  ),
  (
    'komandorskiy',
    'Командорский заповедник',
    'Острова Беринга и Медный. Котики, редкие птицы, Берингово море. Требует отдельного разрешения.',
    'eastern',
    '+7 (4152) 23-53-62',
    'https://komandorsky.ru',
    'Командорск'
  )
ON CONFLICT (slug) DO NOTHING;

COMMIT;
