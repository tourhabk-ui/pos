-- 1031: зона планера у объекта жилья.
--
-- ── Решение владельца 26.09 ───────────────────────────────────────────────
--
-- Планер поездки показывает НАСТОЯЩЕЕ жильё на ночи плана: объекты с
-- витрины, свободные на эти ночи, в той зоне, где план ночует. Для этого
-- у объекта должна быть зона в тех же ключах, какими считает движок
-- (ZoneId, lib/planner/constants.ts): avachinsky / western / eastern /
-- northern.
--
-- ── Почему новая колонка, а не location_zone ──────────────────────────────
--
-- location_zone (716) — свободный текст владельца («Паратунка», «Елизово,
-- 20 км от аэропорта»). Перевод текста в зону движка владелец отверг: это
-- угадывание, и ошибка угадывания отправит туриста ночевать за двести
-- километров от его дня. Поле текста остаётся как есть, для людей.
--
-- ── Заполнение существующих строк: НЕТ ────────────────────────────────────
--
-- Правило «с уверенностью» искалось по координатам (coordinates NOT NULL
-- у всех объектов). Надёжного правила нет: у планера есть только ЦЕНТРЫ
-- зон (ZONE_COORDS в lib/planner/engine.ts), а не границы, и центры
-- восточной (54.80, 160.50) и северной (54.50, 160.27) зон лежат в
-- ~40 км друг от друга. «Ближайший центр» — та же догадка, что текст,
-- только числом. Поэтому все существующие строки остаются NULL — «зона не
-- размечена» (§4.0). Такой объект планер НЕ предлагает; зону ставит
-- владелец в кабинете или администратор на модерации.
--
-- Новые объекты получают зону обязательным полем формы владельца
-- (POST /api/stay/accommodations); база при этом NULL допускает —
-- объекты, заведённые администратором и импортом, честно «не размечены».
--
-- Идемпотентна.

ALTER TABLE accommodations
  ADD COLUMN IF NOT EXISTS planner_zone VARCHAR(20) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'accommodations_planner_zone_check'
       AND conrelid = 'accommodations'::regclass
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_planner_zone_check
      CHECK (planner_zone IS NULL OR planner_zone IN ('avachinsky', 'western', 'eastern', 'northern'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accommodations_planner_zone
  ON accommodations (planner_zone)
  WHERE planner_zone IS NOT NULL;

COMMENT ON COLUMN accommodations.planner_zone IS
  'Зона планера (ZoneId: avachinsky/western/eastern/northern). NULL — зона не размечена, планер объект не предлагает. Миграция 1031.';
