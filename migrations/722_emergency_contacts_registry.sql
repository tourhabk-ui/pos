-- Migration 722: справочник официальных телефонов + поле «назначение» (issue #366)
--
-- Проблема: официальные/экстренные номера зашиты хардкодом минимум в 7 файлах
-- и расходятся между собой (6 разных МЧС/спасательных номеров), а портал
-- visitkamchatka.ru/security/ публикует свои номера с разделением по
-- назначению — и ни один не совпадает с нашими.
--
-- Этот шаг — ТОЛЬКО инфраструктура сверки: справочник с назначением
-- (purpose) и источником (source). Номера в SOS-файлах НЕ меняются —
-- только после сверки с Артёмом (решение владельца, issue #366).
-- Портальные номера сидятся как ВТОРОЙ источник (source='visitkamchatka'),
-- НЕ верифицированные: портал сам местами протух.
--
-- Существующие строки сида 0645 помечаются source='seed' — их происхождение
-- неизвестно (номера вида +7 (415) 223-00-11 похожи на выдуманные при сиде).
--
-- Идемпотентна: safe to run multiple times.

BEGIN;

ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS purpose     VARCHAR(30);
ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS source      VARCHAR(30);
ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS source_url  TEXT;
ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS verified_by TEXT;
ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS notes       TEXT;

DO $$ BEGIN
  ALTER TABLE emergency_contacts
    ADD CONSTRAINT chk_emergency_contacts_purpose
    CHECK (purpose IS NULL OR purpose IN ('emergency', 'registration', 'consultation', 'permit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE emergency_contacts
    ADD CONSTRAINT chk_emergency_contacts_source
    CHECK (source IS NULL OR source IN ('code', 'visitkamchatka', 'seed', 'verified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Старый сид 0645: происхождение номеров неизвестно
UPDATE emergency_contacts SET source = 'seed' WHERE source IS NULL;

-- ── Сид: номера, зашитые в коде (source='code') ───────────────────────────────
-- Инвентаризация фактического кода (июль 2026), notes — файлы-носители.
-- Это НЕ верифицированные номера — это то, что реально показывается юзерам.
INSERT INTO emergency_contacts (zone, contact_type, name, phone, purpose, source, notes)
SELECT v.zone, v.contact_type, v.name, v.phone, v.purpose, 'code', v.notes
FROM (VALUES
  (NULL, 'mches', 'ГУ МЧС по Камчатскому краю', '+7 (4152) 23-53-62', 'emergency',
   'app/sos/page.tsx, public/emergency.html. Стационарный, SMS теряются (MEMORY)'),
  (NULL, 'pso', 'ПСО «Камчатка»', '+7 (4152) 41-27-30', 'emergency',
   'app/sos/page.tsx, public/emergency.html'),
  (NULL, 'mches', 'МЧС (дежурный)', '+7 (4152) 29-99-99', 'emergency',
   'app/hub/safety/_SafetyHubClient.tsx, app/safety/_SafetyClient.tsx'),
  (NULL, 'pass', 'ПАСС Камчатки', '+7 (4152) 41-03-03', 'emergency',
   'app/hub/safety/_SafetyHubClient.tsx (3 вхождения, включая offline-fallback), app/api/safety/rescue-chat/route.ts, app/safety/_SafetyClient.tsx. Подозрительно похож на портальный 41-03-95'),
  (NULL, 'unknown', 'Экстренный (назначение в коде не указано)', '+7 (4152) 41-11-11', 'emergency',
   'components/places/PlaceSOS.tsx — назначение номера из кода не ясно'),
  (NULL, 'mches', 'МЧС (версия Кузьмича)', '+7 (4152) 11-05-05', 'emergency',
   'lib/kuzmich/core.ts:1844'),
  (NULL, 'ecospas', 'ЭКОСПАС', '+7 (4152) 42-40-27', 'emergency',
   'app/hub/safety/_SafetyHubClient.tsx, app/api/safety/rescue-chat/route.ts')
) AS v(zone, contact_type, name, phone, purpose, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM emergency_contacts e WHERE e.phone = v.phone AND e.source = 'code'
);

-- ── Сид: номера портала visitkamchatka.ru/security/ (source='visitkamchatka') ─
-- ВТОРОЙ источник для сверки, НЕ верифицированы (verified_at IS NULL).
INSERT INTO emergency_contacts (zone, contact_type, name, phone, purpose, source, source_url, notes)
SELECT v.zone, v.contact_type, v.name, v.phone, v.purpose, 'visitkamchatka',
       'https://visitkamchatka.ru/security/', v.notes
FROM (VALUES
  (NULL, 'pso', 'ПСО Камчатского края', '+7 (4152) 41-03-95', 'consultation',
   'Консультации по маршрутам/снаряжению. Подозрительно похож на наш 41-03-03 (ПАСС) — где-то опечатка'),
  (NULL, 'cuks', 'Оперативный дежурный ЦУКС ГУ МЧС', '+7 (4152) 30-10-81', 'registration',
   'Регистрация туристических групп. Адрес: ул. Тундровая, 6'),
  (NULL, 'wildlife', 'Служба охраны животного мира', '+7 (4152) 23-85-70', 'permit',
   'Разрешения на посещение ООПТ')
) AS v(zone, contact_type, name, phone, purpose, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM emergency_contacts e WHERE e.phone = v.phone AND e.source = 'visitkamchatka'
);

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_source_purpose
  ON emergency_contacts (source, purpose);

COMMIT;
