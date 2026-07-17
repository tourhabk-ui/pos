-- 748_verified_emergency_contacts.sql
--
-- Финал сверки телефонов (issue #366): владелец (Артём Клоков, 2026-07-17)
-- подтвердил номера дежурной смены МЧС Камчатки:
--   СОД (старший оперативный дежурный): 30-10-89 и 20-01-12
--   НДС (начальник дежурной смены):     30-10-91
-- Код города 4152 (Петропавловск-Камчатский).
--
-- Это ПЕРВЫЕ строки source='verified' в реестре — до них показ регионалок
-- был запрещён (только 112). UI-источник — lib/safety/emergency-numbers.ts
-- (VERIFIED_REGIONAL), реестр хранит происхождение и дату верификации.
--
-- Идемпотентна: safe to run multiple times.

INSERT INTO emergency_contacts
  (zone, contact_type, name, phone, purpose, source, verified_at, verified_by, notes)
SELECT v.zone, v.contact_type, v.name, v.phone, v.purpose, 'verified', NOW(), 'Артём Клоков (владелец)', v.notes
FROM (VALUES
  (NULL, 'mches', 'МЧС Камчатки — оперативный дежурный (СОД)', '+7 (4152) 30-10-89', 'emergency',
   'Старший оперативный дежурный, основной номер. Подтверждено владельцем 2026-07-17'),
  (NULL, 'mches', 'МЧС Камчатки — оперативный дежурный, резерв (СОД)', '+7 (4152) 20-01-12', 'emergency',
   'Старший оперативный дежурный, резервный номер. Подтверждено владельцем 2026-07-17'),
  (NULL, 'mches', 'МЧС Камчатки — начальник дежурной смены (НДС)', '+7 (4152) 30-10-91', 'emergency',
   'Начальник дежурной смены. Подтверждено владельцем 2026-07-17')
) AS v(zone, contact_type, name, phone, purpose, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM emergency_contacts e WHERE e.phone = v.phone AND e.source = 'verified'
);
