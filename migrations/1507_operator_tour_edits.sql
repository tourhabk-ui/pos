-- 1507: черновик правки содержания тура — на витрину только после проверки.
-- Created: 2026-11-23
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- План готовности 23.11, этап 4. До этого дня оператор и гид меняли
-- название, описание, программу, цену и снимки тура сразу на витрине, а
-- публикацию включали одной галочкой. Для пилотов это было приемлемо; для
-- новых партнёров — нет: турист читал бы то, чего никто не проверил.
--
-- Живая строка operator_tours остаётся на витрине как есть — это последняя
-- одобренная версия. Правка содержания ложится сюда черновиком со статусом
-- pending. На витрину она попадает, только когда администратор одобрит
-- черновик в /hub/admin/moderation: код тогда переписывает колонки живой
-- строки (lib/tours/moderation-store, decideTourEdit). Отклонение живую
-- строку не трогает. Скрыть тур, поменять даты и число мест можно сразу —
-- этой таблицей они не идут.
--
-- Один pending на тур: следующая правка дополняет тот же черновик.
--
-- ── Существующие туры ─────────────────────────────────────────────────────
--
-- Ни одна строка operator_tours не меняется: уже опубликованные туры
-- остаются опубликованными и в очередь задним числом не попадают. Правило
-- действует на правки и публикации после выката.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS operator_tour_edits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id           BIGINT NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  -- Карточка, чей тур правится (operator_tours.operator_id на момент правки).
  partner_id        UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Правка: ключ — колонка тура, значение — новое. Ключа нет — поле не
  -- меняется; JSON null — поле очищается. Список колонок держит код
  -- (lib/tours/moderation, MODERATED_TOUR_COLUMNS).
  patch             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Просьба опубликовать тур: одобрение ставит is_published = TRUE.
  wants_publish     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Что стояло на витрине в этих полях в момент одобрения — для истории.
  live_before       JSONB,
  moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  moderation_reason TEXT,
  moderated_at      TIMESTAMPTZ,
  moderated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_tour_edits_patch_object CHECK (jsonb_typeof(patch) = 'object'),
  -- Пустой черновик без просьбы о публикации проверять нечего.
  CONSTRAINT operator_tour_edits_has_change CHECK (patch <> '{}'::jsonb OR wants_publish)
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_tour_edits_one_pending
  ON operator_tour_edits (tour_id)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS operator_tour_edits_pending_created
  ON operator_tour_edits (created_at)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS operator_tour_edits_partner
  ON operator_tour_edits (partner_id, created_at DESC);

COMMENT ON TABLE operator_tour_edits IS
  'Черновик правки содержания тура (1507). На витрине его нет: живая строка operator_tours меняется только после approved';
COMMENT ON COLUMN operator_tour_edits.patch IS
  'Правка: {колонка: новое значение}. Ключа нет — поле не меняется; null — поле очищается';
COMMENT ON COLUMN operator_tour_edits.wants_publish IS
  'Просьба опубликовать тур: одобрение ставит operator_tours.is_published = TRUE';
COMMENT ON COLUMN operator_tour_edits.live_before IS
  'Значения тех же полей на витрине в момент одобрения. NULL — черновик ещё не одобрен';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS operator_tour_edits;
-- COMMIT;
