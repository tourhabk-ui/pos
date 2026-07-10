-- Migration 739: таблицы админ-настроек (system_settings, email_templates)
--
-- Экран «Настройки» (admin) падал с «Ошибка загрузки настроек»:
-- GET /api/admin/settings делает SELECT из system_settings и email_templates,
-- а этих таблиц на проде НЕТ. DDL лежал в lib/database/admin_schema.sql —
-- отдельном файле, который никогда не попал в конвейер migrations/, поэтому
-- на этом инстансе таблицы не создались.
--
-- Переносим DDL в миграцию (идемпотентно). gen_random_uuid() вместо
-- uuid_generate_v4() — не требует расширения uuid-ossp (pgcrypto штатно
-- есть в PG13+, как в остальных миграциях проекта). Индексы — IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS system_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         VARCHAR(100) UNIQUE NOT NULL,
  value       TEXT NOT NULL,
  description TEXT,
  category    VARCHAR(50) DEFAULT 'general',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);

CREATE TABLE IF NOT EXISTS email_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(255) NOT NULL,
  subject      VARCHAR(500) NOT NULL,
  type         VARCHAR(50) NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,
  variables    JSONB DEFAULT '[]',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_templates_type ON email_templates(type);
CREATE INDEX IF NOT EXISTS idx_email_templates_is_active ON email_templates(is_active);

COMMIT;
