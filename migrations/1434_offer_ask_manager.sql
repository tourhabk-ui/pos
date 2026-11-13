-- Migration 1434: «Беру» другой компании — менеджеру, если чат человека не принял
-- (план «после отказа», этап 4б-2)
-- Created: 2026-11-12
--
-- 1433 завела вопрос другим компаниям и ответ «Беру». О «Беру» человеку
-- сообщают в его чат (told_via). Если чата нет или он сообщение не принял,
-- ответ компании видел только тот, кто сам откроет страницу заявки: заявка с
-- формы сайта чата не имеет, и слово компании «возьму» не узнавал никто.
--
-- Правило плана «доставлено»: не дошло до человека — сразу менеджеру, с
-- телефоном, в его MAX. Здесь — куда ушло письмо менеджеру о «Беру»:
--   manager_via — 'max' (письмо с именем и телефоном принято рабочим чатом MAX)
--                 или 'telegram-stub' (MAX не принял; в Telegram — заглушка без
--                 ПД); NULL — письма не было или оно не дошло;
--   manager_at  — когда.
-- told_via остаётся про чат самого человека: «человек узнал» и «менеджеру
-- передано» — разные состояния, и одно за другое не выдаётся.
--
-- Имени и телефона в таблице по-прежнему нет.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS; ограничения — через проверку каталога.

BEGIN;

ALTER TABLE other_offer_asks ADD COLUMN IF NOT EXISTS manager_via TEXT NULL;
ALTER TABLE other_offer_asks ADD COLUMN IF NOT EXISTS manager_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ooa_manager_via_check') THEN
    ALTER TABLE other_offer_asks
      ADD CONSTRAINT ooa_manager_via_check CHECK (manager_via IS NULL OR manager_via IN ('max', 'telegram-stub'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ooa_manager_pair') THEN
    ALTER TABLE other_offer_asks
      ADD CONSTRAINT ooa_manager_pair CHECK ((manager_via IS NULL) = (manager_at IS NULL));
  END IF;
  -- Менеджеру пишут только о «Беру».
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ooa_manager_only_take') THEN
    ALTER TABLE other_offer_asks
      ADD CONSTRAINT ooa_manager_only_take CHECK (manager_via IS NULL OR answer = 'take');
  END IF;
END $$;

COMMENT ON COLUMN other_offer_asks.manager_via IS
  'Куда ушло письмо менеджеру о «Беру», когда чат человека его не принял: max / telegram-stub; NULL — письма не было или оно не дошло (lib/requests/offer-asks).';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE other_offer_asks DROP CONSTRAINT IF EXISTS ooa_manager_only_take;
-- ALTER TABLE other_offer_asks DROP CONSTRAINT IF EXISTS ooa_manager_pair;
-- ALTER TABLE other_offer_asks DROP CONSTRAINT IF EXISTS ooa_manager_via_check;
-- ALTER TABLE other_offer_asks DROP COLUMN IF EXISTS manager_at;
-- ALTER TABLE other_offer_asks DROP COLUMN IF EXISTS manager_via;
-- COMMIT;
