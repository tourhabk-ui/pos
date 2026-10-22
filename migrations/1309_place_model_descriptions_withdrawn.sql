-- 1309: описания мест, написанные моделью, — с карточек в архивную колонку
--       (решение владельца 22.10: «1 да»).
-- Created: 2026-10-22
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 22.10: «отключи агента выдумывающкюего описание мест такую пургу
-- придумал». Писателей текстов мест моделью выключил выключатель
-- MODEL_WRITES_PLACE_TEXT (lib/places/model-place-text.ts). На вопрос «снять
-- с карточек мест описания, которые уже написала модель? Текст останется в
-- базе, вернуть можно» владелец ответил «1 да».
--
-- ── Какие — правилом карточки, а не догадкой по тексту ────────────────────
--
-- Ровно те, что карточка подписывает «написала модель»
-- (lib/places/description-by-model, `descriptionWrittenByModel`):
-- последняя запись журнала происхождения (911) — писатель-модель
-- (editor-ai, editor-ai-runner:*, enrich-places-ai, enrich-routes-ai), и
-- длина описания с тех пор та же. Описание, правленное после модели
-- человеком или миграцией, решение владельца (owner-decision) и текст без
-- журнала не трогаются: кто их писал, не знаем, и снимать их значило бы
-- назвать чужой текст машинным. Совпадение этого SQL с правилом карточки
-- держит tests/integration/place-model-descriptions-withdrawn.pg.test.ts.
--
-- ── Как — прячем, не удаляем (как 1247) ───────────────────────────────────
--
-- Текст переезжает в description_withdrawn с причиной и временем,
-- description становится NULL: все поверхности перестают его показывать
-- разом, карточка говорит словами, что описание убрано (PlaceDescription).
-- Модель дыру не заполнит: писатели выключены, а очереди Editor и
-- enrich-* снятое и так не берут. Место, где архивная колонка уже занята
-- (дневник 1247), не трогается — история не затирается; модель туда не
-- писала, её очереди такие места не брали.
--
-- Сколько снято — пишет NOTICE в лог выката; после выката — перепись
-- GET /api/cron/description-writers-census (by_model должен стать 0).
--
-- IDEMPOTENT: повтор — no-op, снятое уже пусто.

BEGIN;

DO $$
DECLARE
  withdrawn_count INTEGER;
BEGIN
  WITH last_write AS (
    SELECT DISTINCT ON (dp.entity_id) dp.entity_id, dp.written_by, dp.chars
      FROM description_provenance dp
     ORDER BY dp.entity_id, dp.written_at DESC, dp.id DESC
  )
  UPDATE places p
     SET description_withdrawn = p.description,
         description_withdrawn_reason = 'Написано моделью без источника; снято словом владельца 22.10 («1 да»)',
         description_withdrawn_at = NOW(),
         description = NULL
    FROM last_write lw
   WHERE lw.entity_id = p.ark_id
     AND p.description IS NOT NULL
     AND btrim(p.description) <> ''
     AND p.description_withdrawn IS NULL
     AND (lw.written_by IN ('editor-ai', 'enrich-places-ai', 'enrich-routes-ai')
          OR lw.written_by LIKE 'editor-ai-runner:%')
     AND lw.chars = char_length(p.description);
  GET DIAGNOSTICS withdrawn_count = ROW_COUNT;
  RAISE NOTICE '1309: описаний мест, написанных моделью, снято с карточек: %', withdrawn_count;
END $$;

COMMIT;
