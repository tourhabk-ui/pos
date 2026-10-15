-- 1290: «Нет режима» и «разрешение не нужно», поставленные без сверки, —
--       в «не записано»; умолчание «не нужно» у колонки разрешения снято.
-- Created: 2026-10-15
--
-- ── Почему ───────────────────────────────────────────────────────────
--
-- §4.0: тип обязан допускать «не знаю», иначе на месте незнания стоит
-- выдумка. У режима места два таких выдуманных значения:
--
--   eco_zone = 'none' — «территория не охраняется». Его не ставил никто,
--     кроме 170, одним UPDATE всем видимым местам, у которых режима не
--     оказалось (`WHERE eco_zone IS NULL AND is_visible`), без сверки.
--     Позже это слово только читали: 1252–1257, 1274, 1288, 1289 пишут
--     режим «поверх пустоты или «нет»». Перепись place-eco-census (проба
--     956): 161 видимое место со словом «нет», ни у одного нет ни правил,
--     ни адреса разрешения;
--   eco_permit_required = FALSE — «разрешение не нужно». Это умолчание
--     колонки (169: `DEFAULT false`), а не ответ: у 93 мест без режима
--     «не нужно» стоит потому, что строку завели, ничего не спросив.
--     Импорт точек маршрутов (lib/import/route-endpoints-runner) заводит
--     места без этих полей — и каждое новое получало «не нужно» само.
--
-- Сверка с контурами охраняемых территорий OSM (place-oopt-contours,
-- прогон 2) «нет» не подтверждает и подтвердить не может: из 259 мест без
-- режима 221 вне всех контуров, но памятников природы в OSM края нет ни
-- одного, а контур «Южно-Камчатского» в OSM неполон (1245). «Вне контура» —
-- не «не охраняется». Честное слово для этих мест — «не записано».
--
-- ── Что видно туристу ──────────────────────────────────────────────────
--
-- Ничего не меняется: карточка и агенты молчат и о «нет», и о «не
-- записано» (PlaceEco, permitNotRequired, connector-tools). Раздел «Что
-- знать» у мест без режима раньше держался только словом «нет» — теперь он
-- показывается всегда (тот же коммит, _PlaceDetailClient), и кнопка 112 не
-- пропадает.
--
-- ── Чего здесь нет ─────────────────────────────────────────────────────
--
-- Записанное рукой не трогается: строки со своими правилами или адресом
-- разрешения остаются как есть. 'none', поставленное после этой миграции
-- (админка), — уже решение человека, а не умолчание.
--
-- IDEMPOTENT

BEGIN;

-- 1. «Не охраняется» без сверки → «не записано», вместе с «не нужно».
UPDATE places
   SET eco_zone = NULL,
       eco_permit_required = NULL,
       updated_at = NOW()
 WHERE eco_zone = 'none'
   AND eco_rules IS NULL
   AND eco_permit_url IS NULL;

-- 2. Режим не записан, а «разрешение не нужно» стоит — умолчание колонки.
UPDATE places
   SET eco_permit_required = NULL,
       updated_at = NOW()
 WHERE eco_zone IS NULL
   AND eco_permit_required IS FALSE
   AND eco_rules IS NULL
   AND eco_permit_url IS NULL;

-- 3. Новое место — «не записано», а не «не нужно».
ALTER TABLE places ALTER COLUMN eco_permit_required DROP DEFAULT;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_none int;
  v_false int;
  v_default text;
BEGIN
  SELECT count(*) INTO v_none FROM places WHERE eco_zone = 'none';
  SELECT count(*) INTO v_false FROM places WHERE eco_zone IS NULL AND eco_permit_required IS FALSE;
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'eco_permit_required';
  IF v_none > 0 THEN
    RAISE NOTICE '[1290] со словом «нет» осталось % мест — у них свои правила или адрес разрешения, записанные рукой', v_none;
  END IF;
  IF v_false > 0 THEN
    RAISE NOTICE '[1290] «не нужно» без режима осталось у % мест — с записанными правилами или адресом', v_false;
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE WARNING '[1290] у eco_permit_required осталось умолчание: %', v_default;
  END IF;
  RAISE NOTICE '[1290] «нет» → «не записано»: осталось «нет» %, «не нужно» без режима %', v_none, v_false;
END $$;

COMMIT;

-- Rollback (возвращает умолчание; «нет» и «не нужно» не возвращаются — они
-- не были сверены):
-- BEGIN;
-- ALTER TABLE places ALTER COLUMN eco_permit_required SET DEFAULT false;
-- COMMIT;
