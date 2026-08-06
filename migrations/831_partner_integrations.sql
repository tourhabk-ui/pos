-- 831: Ключи интеграций партнёров (Tilda API и будущие провайдеры).
--
-- Источник: владелец, 06.08.2026 — «я не хочу в переменные добавлять ключи
-- партнёра, он же будет не один — давай добавим в Партнёра». Ключи каждого
-- партнёра живут у его записи в базе, а не в env платформы: партнёров много,
-- env один.
--
-- Отдельная таблица, а не колонка в partners: витрина и каталог постоянно
-- читают partners целиком, и секрет в той же строке рано или поздно утёк бы
-- через очередной SELECT *. Таблицу с ключами публичный код не трогает вовсе
-- (сторож: tests/unit/partner-integrations.test.ts).
--
-- Сами ключи сюда НЕ пишутся: их вносит администратор через админку
-- (PUT /api/admin/operators/[id]/integrations/tilda). В репозитории ключей нет.

CREATE TABLE IF NOT EXISTS partner_integrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (partner_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_partner_integrations_partner
  ON partner_integrations (partner_id);
