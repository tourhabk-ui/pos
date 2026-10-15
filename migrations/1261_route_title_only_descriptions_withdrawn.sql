-- 1261: описания маршрутов, написанные агентом по одному названию, — с
--       карточек в архивную колонку, до переписи по источникам (решение
--       владельца 15.10: «5 скрой»).
-- Created: 2026-10-15
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Перепись описаний маршрутов (GET /api/cron/route-desc-census, v6, проба
-- 852): у 150 из 389 живых маршрутов текст записал агент enrich-routes
-- (metadata.enriched_by = 'admin_api'). Агент знал о маршруте только
-- название, тип и прежний текст, — значит всё остальное в описании догадка.
-- У 96 из 150 перепись нашла сказанное сверх записи: другое имя места,
-- число, опасность, рассказ от первого лица. Проверка после модели (14.10)
-- закрыла путь новым таким текстам, а записанные остались на карточках.
--
-- Владелец на вопрос, скрыть ли эти описания до переписи по источникам,
-- ответил «скрой».
--
-- ── Как — прячем, не удаляем ──────────────────────────────────────────────
--
-- Тот же приём, что у мест в 1247: текст переезжает в
-- kamchatka_routes.description_withdrawn (с причиной и временем), а
-- description становится NULL — и все поверхности, читающие описание
-- маршрута (карточка, мета и JSON-LD, каталог, Кузьмич, MCP), перестают его
-- показывать разом. Карточка говорит словами, что описание убрано и
-- переписывается (components/routes/RouteDescriptionNotice). Переписанное
-- по источникам ложится в description как обычно; архивная колонка остаётся
-- историей.
--
-- Писатель enrich-routes пустое описание такого маршрута не заполняет: иначе
-- дыру закрыл бы новый текст по тому же названию, и маршрут выглядел бы
-- переписанным.
--
-- ── Какие маршруты ────────────────────────────────────────────────────────
--
-- Отбор — по той же метке, по которой их назвала перепись: enriched_by =
-- 'admin_api' ставит только этот агент (app/api/admin/enrich-routes). Метка
-- остаётся и у скрытых и слитых маршрутов: их тексты сняты тоже — не видны
-- сейчас, но слияние дублей (lib/services/data-repair) заполняет пустое
-- описание оставшегося текстом дубля, и догадка вернулась бы на карточку
-- чужой дверью. После 1110 ни одна миграция описание маршрута по id не
-- переписывала, так что поверх текста агента не лежит ничего проверенного.
-- Повтор — no-op: перенесённое уже пусто.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS description_withdrawn TEXT;
ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS description_withdrawn_reason TEXT;
ALTER TABLE kamchatka_routes ADD COLUMN IF NOT EXISTS description_withdrawn_at TIMESTAMPTZ;

COMMENT ON COLUMN kamchatka_routes.description_withdrawn IS
  'Описание, снятое с карточки маршрута (миграция 1261: написано агентом по одному названию, источника нет). Хранится как история; наружу не отдаётся. Переписанное по источникам ложится в description.';

UPDATE kamchatka_routes
   SET description_withdrawn = description,
       description_withdrawn_reason = 'написано агентом enrich-routes по одному названию маршрута: источника у текста нет; снято решением владельца 15.10 («5 скрой») до переписи по справочникам — миграция 1261',
       description_withdrawn_at = NOW(),
       description = NULL,
       updated_at = NOW()
 WHERE metadata->>'enriched_by' = 'admin_api'
   AND description IS NOT NULL
   AND btrim(description) <> ''
   AND description_withdrawn IS NULL;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_live int;
  v_other int;
  v_left int;
BEGIN
  SELECT count(*) FILTER (WHERE is_visible = TRUE AND merged_into_id IS NULL),
         count(*) FILTER (WHERE NOT (is_visible = TRUE AND merged_into_id IS NULL))
    INTO v_live, v_other
    FROM kamchatka_routes
   WHERE description_withdrawn IS NOT NULL
     AND description_withdrawn_reason LIKE '%миграция 1261';
  SELECT count(*) INTO v_left
    FROM kamchatka_routes
   WHERE metadata->>'enriched_by' = 'admin_api'
     AND description IS NOT NULL AND btrim(description) <> ''
     AND description_withdrawn IS NULL;

  RAISE NOTICE '[1261] описаний агента снято: живых маршрутов %, скрытых и слитых %', v_live, v_other;
  IF v_left > 0 THEN
    RAISE WARNING '[1261] у % маршрутов текст агента остался на карточке', v_left;
  END IF;
END $$;

COMMIT;

-- Вернуть (если владелец решит показывать эти тексты снова):
-- BEGIN;
-- UPDATE kamchatka_routes
--    SET description = description_withdrawn,
--        description_withdrawn = NULL, description_withdrawn_reason = NULL, description_withdrawn_at = NULL,
--        updated_at = NOW()
--  WHERE description IS NULL
--    AND description_withdrawn IS NOT NULL
--    AND description_withdrawn_reason LIKE '%миграция 1261';
-- COMMIT;
