-- 1027: объект жилья выходит на витрину только после проверки администратором.
--
-- ── Решение владельца 26.09 ───────────────────────────────────────────────
--
-- «Объекты появляются в публичном каталоге ТОЛЬКО после одобрения
-- администратором; отметку „Проверено“ ставит администратор».
--
-- До этого дня POST /api/stay/accommodations вставлял объект сразу с
-- is_active = true, а витрина (app/api/accommodations, карточка, Кузьмич,
-- MCP, планер, sitemap) фильтровала только по is_active. Экран владельца
-- обещал «появится на витрине после проверки» — проверки не было вовсе, и
-- is_verified не выставлял НИКТО: обещание без механизма (§10.09).
--
-- ── Почему отдельная колонка, а не is_active / is_verified ────────────────
--
-- is_active — выключатель ВЛАДЕЛЬЦА («скрыть на время»). Если бы им же
-- управляла модерация, владелец одним нажатием «показать» публиковал бы
-- непроверенный объект, а снятие с проверки было бы неотличимо от паузы.
--
-- is_verified — отметка «Проверено» для туриста. Она — СЛЕДСТВИЕ одобрения,
-- а не шлюз: у отказа есть причина, у ожидания нет ни того ни другого, а
-- булево поле не умеет сказать «на проверке» и «отклонено» раздельно (§4.0).
--
-- Поэтому:
--   moderation_status  pending | approved | rejected — шлюз витрины;
--   moderation_reason  причина отказа (обязательна при rejected — CHECK);
--   moderated_at/_by   кто и когда решил. NULL у approved — «одобрен до
--                      введения проверки» (см. ниже), а не выдуманная дата.
--
-- Витрина = is_active AND moderation_status = 'approved'
-- (lib/stay/moderation.ts, publicAccommodationSql). Одобрение ставит
-- is_verified = true, отказ — false (app/api/admin/accommodations/[id]).
--
-- ── Существующие объекты ──────────────────────────────────────────────────
--
-- ВСЕ строки, заведённые до этой миграции, получают 'approved' с пустыми
-- moderated_at/moderated_by. Причина: до 26.09 заведение объекта И БЫЛО
-- публикацией, и живой каталог прятать задним числом нельзя — турист,
-- открывший вчера ссылку, получил бы 404 без всякого решения человека.
-- Скрытые (is_active = false) тоже 'approved': их скрыл владелец или
-- администратор выключателем, и включение возвращает ровно прежнее
-- поведение. is_verified у существующих строк НЕ трогается: «одобрен до
-- проверки» не значит «проверен», и отметку «Проверено» они получат только
-- решением администратора.
--
-- ── Бронь ─────────────────────────────────────────────────────────────────
--
-- Триггер на accommodation_bookings отказывает во вставке брони объекта,
-- который не одобрен: витрина его не показывает, но id мог утечь (прямая
-- ссылка, старый кэш). Шлюз в базе держит ЛЮБУЮ дверь брони, а не только
-- ту, где не забыли условие.
--
-- ── Рейтинг партнёров жилья ───────────────────────────────────────────────
--
-- Профиль партнёра 'stay' заводился с rating = 0 (partners.rating DEFAULT
-- 0.0 и явный 0 в lib/auth/partner-profile.ts, app/api/auth/register). Ноль
-- — не оценка (отзывы ставят от 1 до 5), это «не знаю», записанное цифрой
-- (§4.0, тот же довод, что у accommodations.rating в 1006). Код с этого
-- дня пишет владельцам жилья NULL; здесь чистятся уже заведённые — только
-- там, где отзывов НЕТ (review_count 0/NULL), то есть ноль заведомо не
-- получен из отзывов. Прочие категории не трогаются: их читатели рейтинга
-- не сверены.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE accommodations
  ADD COLUMN IF NOT EXISTS moderation_status varchar(16),
  ADD COLUMN IF NOT EXISTS moderation_reason text,
  ADD COLUMN IF NOT EXISTS moderated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS moderated_by      uuid;

-- Существующие — одобрены «до проверки» (обоснование выше). Только там,
-- где статуса ещё нет: повторный прогон ничьих решений не перепишет.
UPDATE accommodations
   SET moderation_status = 'approved'
 WHERE moderation_status IS NULL;

ALTER TABLE accommodations ALTER COLUMN moderation_status SET DEFAULT 'pending';
ALTER TABLE accommodations ALTER COLUMN moderation_status SET NOT NULL;

ALTER TABLE accommodations DROP CONSTRAINT IF EXISTS accommodations_moderation_status_check;
ALTER TABLE accommodations
  ADD CONSTRAINT accommodations_moderation_status_check
  CHECK (moderation_status IN ('pending', 'approved', 'rejected'));

-- Отказ без причины владельцу нечего исправлять.
ALTER TABLE accommodations DROP CONSTRAINT IF EXISTS accommodations_rejection_has_reason;
ALTER TABLE accommodations
  ADD CONSTRAINT accommodations_rejection_has_reason
  CHECK (moderation_status <> 'rejected' OR length(btrim(COALESCE(moderation_reason, ''))) > 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_moderated_by_fkey'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_moderated_by_fkey
      FOREIGN KEY (moderated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accommodations_moderation_status
  ON accommodations (moderation_status);

COMMENT ON COLUMN accommodations.moderation_status IS
  'Шлюз витрины: pending — на проверке, approved — одобрен, rejected — отклонён (причина в moderation_reason). Публично = is_active AND approved. Миграция 1027.';
COMMENT ON COLUMN accommodations.moderation_reason IS
  'Причина отказа — видна владельцу. Обязательна при rejected.';
COMMENT ON COLUMN accommodations.moderated_at IS
  'Когда администратор решил. NULL у approved — одобрен до введения проверки (1027), решения человека не было.';

-- ── Бронь только одобренного объекта ─────────────────────────────────────
CREATE OR REPLACE FUNCTION accommodation_booking_requires_approved()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.accommodation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accommodations
     WHERE id = NEW.accommodation_id
       AND moderation_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Объект размещения не прошёл проверку платформы — бронирование недоступно'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accommodation_booking_requires_approved ON accommodation_bookings;
CREATE TRIGGER trg_accommodation_booking_requires_approved
  BEFORE INSERT ON accommodation_bookings
  FOR EACH ROW EXECUTE FUNCTION accommodation_booking_requires_approved();

-- ── Рейтинг партнёров жилья: ноль без отзывов → NULL ─────────────────────
UPDATE partners
   SET rating = NULL
 WHERE category = 'stay'
   AND rating = 0
   AND COALESCE(review_count, 0) = 0;

COMMIT;
