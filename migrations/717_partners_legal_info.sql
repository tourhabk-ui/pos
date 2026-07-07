-- Migration 717: юридические поля партнёра (форма 152-ФЗ)
--
-- Проблема: POST /api/partners/register пишет в колонки partners, которых
-- не существует ни в одном DDL (legal_info, bank_details, consents,
-- operator_info, roles, password_hash, status) — эндпоинт падал на первом
-- же INSERT. Колонки нужны: юр. данные (ИНН/ОГРН), банковские реквизиты
-- и зафиксированные согласия обязаны храниться по 152-ФЗ.
--
-- password_hash и status намеренно НЕ добавляются: пароль хранится в users
-- (единый lib/auth/password), статус модерации — существующий
-- partners.profile_status (migration 052).
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS legal_info    JSONB,
  ADD COLUMN IF NOT EXISTS bank_details  JSONB,
  ADD COLUMN IF NOT EXISTS consents      JSONB,
  ADD COLUMN IF NOT EXISTS operator_info JSONB,
  ADD COLUMN IF NOT EXISTS roles         JSONB DEFAULT '[]';

-- Поиск дублей при регистрации идёт по ИНН
CREATE INDEX IF NOT EXISTS idx_partners_legal_inn
  ON partners ((legal_info->>'inn'))
  WHERE legal_info IS NOT NULL;

COMMIT;
