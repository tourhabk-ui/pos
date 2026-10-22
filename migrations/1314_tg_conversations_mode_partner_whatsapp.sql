-- Migration 1314: переписка Кузьмича с партнёром и в WhatsApp сохраняется
-- Created: 2026-10-22
--
-- ── Зачем ─────────────────────────────────────────────────────────────────
-- Вопрос владельца 22.10: «кузьмич вчера 3 ответа а в переписках нету кто
-- откуда». Разбор нашёл, что два входа Кузьмича не оставляют переписки вовсе.
--
-- saveMsg (lib/kuzmich/core.ts) пишет сообщение в tg_conversations с родом
-- разговора `mode`, а CHECK из миграции 128 знает только четыре рода:
-- admin, tourist, max, telegram. Два рода код пишет мимо него:
-- - `operator_tg` — чат партнёра с Кузьмичом в Telegram
--   (processPartnerMessage, lib/kuzmich/operator-chat.ts);
-- - `whatsapp` — вход WhatsApp (app/api/whatsapp/kuzmich).
--
-- Каждая такая запись падала на 23514, а пустой catch в saveMsg глотал
-- отказ. Отсюда два следствия: в «Переписках» админки этих разговоров нет,
-- и Кузьмич партнёра не помнит предыдущей реплики — getHistory читает
-- историю по тому же роду и находит пустоту.
--
-- ── Что ───────────────────────────────────────────────────────────────────
-- Список родов расширен до тех, что пишет код. Прежние строки проходят и
-- новую проверку (новый список — надмножество). Если на проде найдутся
-- строки вне списка (ограничение могли когда-то снимать руками), миграция не
-- падает и чужое не переписывает: ограничение ставится NOT VALID, роды
-- называются предупреждением. Образец — 1026.
--
-- Сторож: tests/integration/admin-day-counts.pg.test.ts — saveMsg с каждым
-- родом, который пишет код, оставляет строку, и getHistory её находит.
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS, затем ADD.

BEGIN;

ALTER TABLE tg_conversations DROP CONSTRAINT IF EXISTS tg_conversations_mode_check;

DO $$
DECLARE
  v_outside text;
BEGIN
  SELECT string_agg(DISTINCT mode, ', ') INTO v_outside
    FROM tg_conversations
   WHERE mode IS NOT NULL
     AND mode NOT IN ('admin', 'tourist', 'max', 'telegram', 'operator_tg', 'whatsapp');

  IF v_outside IS NULL THEN
    ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_mode_check CHECK (
      mode IN ('admin', 'tourist', 'max', 'telegram', 'operator_tg', 'whatsapp')
    );
  ELSE
    RAISE WARNING '[1314] в tg_conversations есть роды вне списка (%): ограничение поставлено NOT VALID, старые строки не проверены', v_outside;
    ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_mode_check CHECK (
      mode IN ('admin', 'tourist', 'max', 'telegram', 'operator_tg', 'whatsapp')
    ) NOT VALID;
  END IF;
END $$;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE tg_conversations DROP CONSTRAINT IF EXISTS tg_conversations_mode_check;
-- ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_mode_check
--   CHECK (mode IN ('admin', 'tourist', 'max', 'telegram')) NOT VALID;
-- COMMIT;
