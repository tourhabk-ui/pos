-- Migration 1212: основание (приказ, распоряжение) у пункта ленты безопасности
-- Created: 2026-10-10
--
-- Повод — разговор владельца 10.10: в ленте «Безопасность» на главной пять
-- пунктов, среди них закрытие дороги на Усть-Большерецк (Октябрьская коса), а
-- руководящего документа нет. Документ при этом был: приказ КГКУ
-- «Камчатуправтодор» от 08.10.2026 «Об ограничении движения транспортных
-- средств» лежал снимком в канале «Право на Руль». У пункта ленты не было даже
-- места, куда его записать: единственное поле «откуда» — source_url, ссылка
-- на новость, а не на основание.
--
-- Колонки — только с производителем и потребителем в этом же PR (10.09):
--   * basis_title — документ словами для человека: «Приказ КГКУ
--     "Камчатуправтодор" от 08.10.2026 № 122 "Об ограничении движения
--     транспортных средств"». Пишут: распознавание снимка
--     (lib/safety/road-basis.ts) и админ руками; читают: главная, /safety,
--     сводка, Кузьмич и MCP safety_status;
--   * basis_url — где документ можно увидеть своими глазами (пост со
--     снимком). Без ссылки распознанный номер проверить было бы нечем;
--   * basis_origin — как основание получено: manual — вписал человек
--     (проверено), image_ocr — прочитано со снимка моделью (не проверено:
--     номер на фото бумаги модель может прочесть неточно, и экран так и
--     говорит);
--   * basis_valid_until — до какого момента документ ограничивает движение,
--     как его прочла модель. Читает сам распознающий: срок пункта он только
--     ПРОДЛЕВАЕТ (GREATEST), никогда не сокращает — лучше лишний час
--     показывать «закрыто», чем отправить людей на закрытую косу;
--   * basis_checked_at / basis_check_outcome — искали ли основание и что
--     нашли: found / no_document (на снимке не документ) / unavailable
--     (зрение не ответило — не смогли проверить, §4.0; повтор через час).
--     Без отметки снимок разбирался бы заново каждые пять минут.

BEGIN;

ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_title TEXT;
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_url TEXT;
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_origin TEXT;
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_valid_until TIMESTAMPTZ;
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_checked_at TIMESTAMPTZ;
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS basis_check_outcome TEXT;

ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_origin_check;
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_basis_origin_check
  CHECK (basis_origin IS NULL OR basis_origin IN ('manual', 'image_ocr'));

-- Основание без происхождения (или наоборот) — непонятно, верить ли ему.
ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_pair;
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_basis_pair
  CHECK ((basis_title IS NULL) = (basis_origin IS NULL));

ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_title_len;
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_basis_title_len
  CHECK (basis_title IS NULL OR char_length(basis_title) BETWEEN 5 AND 400);

ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_check_outcome_check;
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_basis_check_outcome_check
  CHECK (basis_check_outcome IS NULL OR basis_check_outcome IN ('found', 'no_document', 'unavailable'));

ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_check_pair;
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_basis_check_pair
  CHECK ((basis_checked_at IS NULL) = (basis_check_outcome IS NULL));

COMMENT ON COLUMN external_alerts.basis_title IS
  'Основание словами: приказ/распоряжение, кто издал, дата, номер, название. NULL — основание не найдено.';
COMMENT ON COLUMN external_alerts.basis_url IS
  'Где основание видно глазами (пост со снимком документа, страница документа).';
COMMENT ON COLUMN external_alerts.basis_origin IS
  'manual — вписал администратор; image_ocr — прочитано моделью со снимка, не проверено человеком.';
COMMENT ON COLUMN external_alerts.basis_valid_until IS
  'До какого момента документ ограничивает движение (как прочитано). Срок пункта им только продлевается.';
COMMENT ON COLUMN external_alerts.basis_checked_at IS
  'Когда автоматический поиск основания смотрел снимок поста.';
COMMENT ON COLUMN external_alerts.basis_check_outcome IS
  'found / no_document / unavailable (зрение не ответило — повтор через час).';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_check_pair;
-- ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_check_outcome_check;
-- ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_title_len;
-- ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_pair;
-- ALTER TABLE external_alerts DROP CONSTRAINT IF EXISTS external_alerts_basis_origin_check;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_check_outcome;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_checked_at;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_valid_until;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_origin;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_url;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS basis_title;
-- COMMIT;
