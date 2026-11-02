-- 1302: класс источника фонда жилья — своя БД Ведара или внешняя PMS партнёра.
--
-- Контекст (исследования 18.10: own-booking-system.md §4/§5,
-- laguna-inventory-db.md §6). Партнёры делятся на два класса:
--
--   vedar_pms    — PMS нет, Ведар сам источник правды по фонду/ценам/броням;
--   external_pms — фонд и шахматка живут во внешней PMS (у «Лагуны» по
--                  публичным следам — Logus HMS), Ведар — канал поверх неё.
--
-- От этого поля в следующих шагах будут зависеть адаптер инвентаря и то,
-- кто считает штраф отмены; в этой миграции поведение НЕ меняется:
-- ни один существующий запрос новые колонки не читает, данные не переписываются.
--
--   inventory_source  vedar_pms | external_pms; NULL у существующих строк —
--                     «класс ещё не проставлен», читатель трактует как
--                     vedar_pms (прежнее поведение, lib/stay/inventory-source.ts).
--                     Осознанно без DEFAULT/backfill: массовая простановка
--                     external_pms без подтверждения партнёра угадала бы класс.
--   pms_vendor        вендор внешней PMS; осмыслен только при external_pms.
--   channel_manager   менеджер каналов внешней PMS, если есть.
--
-- Значения словарей держит lib/stay/inventory-source.ts; новое значение —
-- только вместе с миграцией, переставляющей соответствующее ограничение.
--
-- Идемпотентна: колонки и ограничения — IF NOT EXISTS.

ALTER TABLE accommodations
  ADD COLUMN IF NOT EXISTS inventory_source TEXT,
  ADD COLUMN IF NOT EXISTS pms_vendor TEXT,
  ADD COLUMN IF NOT EXISTS channel_manager TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_inventory_source_check'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_inventory_source_check
      CHECK (inventory_source IS NULL OR inventory_source IN ('vedar_pms', 'external_pms'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_pms_vendor_check'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_pms_vendor_check
      CHECK (pms_vendor IS NULL OR pms_vendor IN ('logus', 'travelline_webpms', 'bnovo', 'exely', 'shelter', '1c_hotel', 'other'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_channel_manager_check'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_channel_manager_check
      CHECK (channel_manager IS NULL OR channel_manager IN ('travelline', 'bnovo', 'exely', 'other', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN accommodations.inventory_source IS
  'Класс источника фонда: vedar_pms — фонд ведёт Ведар, external_pms — внешняя PMS партнёра, Ведар канал поверх неё. NULL — не проставлен, читается как vedar_pms.';
COMMENT ON COLUMN accommodations.pms_vendor IS
  'Вендор внешней PMS (logus/travelline_webpms/bnovo/exely/shelter/1c_hotel/other); осмыслен только при inventory_source=external_pms.';
COMMENT ON COLUMN accommodations.channel_manager IS
  'Менеджер каналов внешней PMS (travelline/bnovo/exely/other/none), если есть.';

INSERT INTO _migrations (name)
VALUES ('1302_accommodation_inventory_source.sql')
ON CONFLICT (name) DO NOTHING;
