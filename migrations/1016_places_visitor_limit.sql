-- 1016: природоохранный лимит места — число людей в сутки с источником.
--
-- ── Зачем ─────────────────────────────────────────────────────────────────
-- Владелец 25.09: «всех туристов нельзя в один поток направлять — 500
-- человек на одну локацию, где есть природоохранные ограничения».
-- Планировщик до этого дня лимитов не читал вовсе, а распределять поток
-- ему было не по чему.
--
-- ── Почему не location_safety_profile.capacity_per_day ────────────────────
-- Та колонка (миграции 0645/070) заведена с DEFAULT 50, и 50 стоит у всех
-- мест, у которых никто ничего не выставлял. Это не норма парка и не закон,
-- а заглушка: верить ей как лимиту значит отказывать людям по выдуманному
-- числу (§4.0). Отличить в ней «выставлено» от «не трогали» нельзя.
--
-- Здесь наоборот: NULL — лимит НЕ ИЗВЕСТЕН (и планировщик так и говорит:
-- не «свободно», а «лимит не установлен»). Число без источника записать
-- нельзя: ограничение places_visitor_limit_has_source требует назвать, чья
-- это норма — приказ дирекции парка, квота заповедника, решение владельца.
--
-- ── Кто пишет, кто читает ─────────────────────────────────────────────────
-- Пишет: POST /api/admin/places/[id]/visitor-limit (админ; источник
--   обязателен, старое значение возвращается в ответе — откат).
-- Читает: lib/planner/flow-balance.ts через recommendTrip — места сверх
--   лимита на даты поездки не предлагаются, туру по такому месту
--   ставится предупреждение.
-- Данных миграция не заполняет: ни одной нормы с источником на 25.09 у нас
-- нет, а выдумывать её нельзя.

ALTER TABLE places ADD COLUMN IF NOT EXISTS visitor_limit_per_day INT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS visitor_limit_source TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS visitor_limit_set_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'places_visitor_limit_positive') THEN
    ALTER TABLE places ADD CONSTRAINT places_visitor_limit_positive
      CHECK (visitor_limit_per_day IS NULL OR visitor_limit_per_day > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'places_visitor_limit_has_source') THEN
    ALTER TABLE places ADD CONSTRAINT places_visitor_limit_has_source
      CHECK (visitor_limit_per_day IS NULL
             OR (visitor_limit_source IS NOT NULL AND length(btrim(visitor_limit_source)) >= 8));
  END IF;
END $$;

COMMENT ON COLUMN places.visitor_limit_per_day IS
  'Природоохранный лимит: сколько людей в сутки. NULL — лимит не известен (не «без ограничений»).';
COMMENT ON COLUMN places.visitor_limit_source IS
  'Источник решения: чья норма при числе (приказ парка, квота заповедника, решение владельца) или почему лимит снят при NULL.';
COMMENT ON COLUMN places.visitor_limit_set_at IS
  'Когда лимит выставлен или снят через /api/admin/places/[id]/visitor-limit.';
