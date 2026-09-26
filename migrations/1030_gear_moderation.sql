-- 1030: позиция проката выходит на витрину только после проверки администратором.
--
-- ── Решение владельца 26.09 ───────────────────────────────────────────────
--
-- На вопрос «кто вправе выставлять позиции проката на витрину» — «как у
-- жилья: модерация админом».
--
-- ── Что было ──────────────────────────────────────────────────────────────
--
-- Дыра в две двери, и обе открывались подряд:
--
--   1. GET /api/gear/profile стоял на requireAuth — то есть достаточно быть
--      ЛЮБЫМ вошедшим человеком, — и при отсутствии профиля САМ заводил
--      партнёра category='gear' (ensureGearPartnerExists). Читающий запрос
--      писал в базу и выдавал роль;
--   2. POST /api/gear/items спрашивал только «есть ли профиль», а он к этому
--      моменту уже был создан первой дверью. Позиция вставлялась с
--      is_active = true;
--   3. публичный каталог (findAvailableGear) фильтровал ровно
--      `is_active AND available_quantity > 0` — ни is_verified партнёра, ни
--      проверки позиции. Снаряжение туриста-самозванца попадало на витрину
--      платформы, которая обещает проверенных партнёров.
--
-- У ЖИЛЬЯ то же место закрыто с 26.09 (миграция 1027), и сторож это держит.
-- У проката не было ни шлюза, ни отметки. Асимметрия между двумя почти
-- одинаковыми ролями — след того, что правило писали дважды и во второй раз
-- не дописали (§12).
--
-- ── Почему отдельная колонка, а не is_active / is_verified ────────────────
--
-- Довод дословно тот же, что в 1027, и потому условие витрины теперь ОДНО на
-- обе таблицы (lib/moderation/gate.ts): у gear_items и accommodations
-- совпадают и имена колонок-шлюзов, и смысл.
--
--   is_active   — выключатель ПАРТНЁРА («снять с проката на время»). Будь он
--                 же шлюзом модерации, партнёр одним нажатием «показать»
--                 публиковал бы непроверенное;
--   is_verified — отметка партнёра, следствие одобрения, а не шлюз позиции;
--   булево вообще не умеет сказать «на проверке» и «отклонено» раздельно,
--   а у отказа обязана быть причина (§4.0).
--
-- ── Существующие позиции ──────────────────────────────────────────────────
--
-- ВСЕ строки, заведённые до этой миграции, получают 'approved' с пустыми
-- moderated_at/moderated_by — по тому же доводу, что в 1027: до сегодня
-- заведение позиции И БЫЛО публикацией, и прятать живой каталог задним
-- числом нельзя. NULL в moderated_at читается как «одобрено до введения
-- проверки», а не как выдуманная дата решения.
--
-- Это сознательно оставляет на витрине то, что могло быть заведено через
-- описанную выше дыру. Разбор таких позиций — работа человека глазами:
-- автоматически отличить самозванца от настоящего прокатчика нечем, а снять
-- витрину целиком значило бы наказать и настоящих. Счёт для разбора даёт
-- запрос из шапки lib/gear/moderation.ts.
--
-- ── Аренда ────────────────────────────────────────────────────────────────
--
-- Триггер на gear_rentals отказывает во вставке аренды неодобренной позиции:
-- витрина её не покажет, но id мог утечь (прямая ссылка, старый кэш). Шлюз
-- в базе держит ЛЮБУЮ дверь аренды, а не только ту, где не забыли условие.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE gear_items
  ADD COLUMN IF NOT EXISTS moderation_status varchar(16),
  ADD COLUMN IF NOT EXISTS moderation_reason text,
  ADD COLUMN IF NOT EXISTS moderated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS moderated_by      uuid;

-- Существующие — одобрены «до проверки» (обоснование выше). Только там, где
-- статуса ещё нет: повторный прогон ничьих решений не перепишет.
UPDATE gear_items
   SET moderation_status = 'approved'
 WHERE moderation_status IS NULL;

ALTER TABLE gear_items ALTER COLUMN moderation_status SET DEFAULT 'pending';
ALTER TABLE gear_items ALTER COLUMN moderation_status SET NOT NULL;

ALTER TABLE gear_items DROP CONSTRAINT IF EXISTS gear_items_moderation_status_check;
ALTER TABLE gear_items
  ADD CONSTRAINT gear_items_moderation_status_check
  CHECK (moderation_status IN ('pending', 'approved', 'rejected'));

-- Отказ без причины партнёру нечего исправлять.
ALTER TABLE gear_items DROP CONSTRAINT IF EXISTS gear_items_rejection_has_reason;
ALTER TABLE gear_items
  ADD CONSTRAINT gear_items_rejection_has_reason
  CHECK (moderation_status <> 'rejected' OR length(btrim(COALESCE(moderation_reason, ''))) > 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gear_items_moderated_by_fkey'
  ) THEN
    ALTER TABLE gear_items
      ADD CONSTRAINT gear_items_moderated_by_fkey
      FOREIGN KEY (moderated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gear_items_moderation_status
  ON gear_items (moderation_status);

COMMENT ON COLUMN gear_items.moderation_status IS
  'Шлюз витрины: pending — на проверке, approved — одобрена, rejected — отклонена (причина в moderation_reason). Публично = is_active AND approved. Миграция 1030.';
COMMENT ON COLUMN gear_items.moderation_reason IS
  'Причина отказа — видна партнёру в кабинете. Обязательна при rejected.';
COMMENT ON COLUMN gear_items.moderated_at IS
  'Когда администратор решил. NULL у approved — одобрено до введения проверки (1030), решения человека не было.';

-- ── Аренда только одобренной позиции ─────────────────────────────────────
CREATE OR REPLACE FUNCTION gear_rental_requires_approved()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.gear_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gear_items
     WHERE id = NEW.gear_id
       AND moderation_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Позиция проката не прошла проверку платформы — аренда недоступна'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gear_rental_requires_approved ON gear_rentals;
CREATE TRIGGER trg_gear_rental_requires_approved
  BEFORE INSERT ON gear_rentals
  FOR EACH ROW EXECUTE FUNCTION gear_rental_requires_approved();

COMMIT;
