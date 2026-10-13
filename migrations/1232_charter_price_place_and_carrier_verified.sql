-- Migration 1232: строка прайса перевозчика ведёт на место; «Шатун» проверен владельцем
-- Created: 2026-10-13
--
-- Стандарт карточки трансфера (решение владельца 13.10, «да делай»): страница
-- перевозчика /transfers/[slug] показывает прайс по направлениям со ссылками
-- на места. До этого строка прайса (миграция 1185) знала направление только
-- словами: «Вулкан Горелый», «Курильское озеро».
--
-- ── place_id ───────────────────────────────────────────────────────────────
--
-- Связь пишется адресом места, сверенным на проде (поиск MCP Ведара 13.10:
-- /places/vulkan-avachinskij, vulkan-gorelyj, vachkazhets, kurilskoe-ozero,
-- vulkan-tolbachik), а не выводится похожестью имени при чтении. Похожесть
-- здесь врёт: «Авачинский» — это и вулкан, и перевал, и бухта; «Горелый» —
-- и вулкан, и его лавовые пещеры (это ОТДЕЛЬНЫЕ места справочника).
--
-- «Толбачик (Мёртвый лес)» ведёт на вулкан Толбачик: Мёртвого леса как
-- отдельного места в справочнике нет, а лес — на склоне этого массива; подпись
-- строки остаётся словами перевозчика.
--
-- NULL — «не связано», и карточка тогда пишет направление текстом, без
-- ссылки. Место скрыто или удалено — ссылки нет (ON DELETE SET NULL; скрытое
-- отсекает чтение по is_visible).
--
-- ── is_verified у «Шатуна» ─────────────────────────────────────────────────
--
-- Миграции 1185 и 1187 оставили FALSE: реквизиты были со слов владельца, а
-- отметку даёт администратор. Владелец 13.10 на «Проверенный оператор (хотя
-- перевозчик не проверен)» ответил: «проверен мной». Отметка ставится по его
-- слову; подпись на странице перевозчика — «Проверенный перевозчик».
-- registry_status не трогается: реестр туроператоров к перевозчику не
-- относится.
--
-- Идемпотентно: колонка IF NOT EXISTS, связь — только в пустое поле, отметка —
-- только если её ещё нет.

BEGIN;

ALTER TABLE transfer_charter_prices
  ADD COLUMN IF NOT EXISTS place_id TEXT REFERENCES places(id) ON DELETE SET NULL;

UPDATE transfer_charter_prices c
   SET place_id = pl.id, updated_at = NOW()
  FROM partners p,
       (VALUES
         ('Вулкан Авачинский',      'vulkan-avachinskij'),
         ('Вулкан Горелый',         'vulkan-gorelyj'),
         ('Вачкажец',               'vachkazhets'),
         ('Курильское озеро',       'kurilskoe-ozero'),
         ('Толбачик (Мёртвый лес)', 'vulkan-tolbachik')
       ) AS m(to_text, place_slug),
       places pl
 WHERE c.partner_id::text = p.id::text
   AND p.slug = 'shatun'
   AND c.line_kind = 'destination'
   AND c.to_text = m.to_text
   AND pl.slug = m.place_slug
   AND c.place_id IS NULL;

UPDATE partners
   SET is_verified = TRUE, updated_at = NOW()
 WHERE slug = 'shatun'
   AND category = 'transfer'
   AND is_verified IS DISTINCT FROM TRUE;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE partners SET is_verified = FALSE WHERE slug = 'shatun';
-- ALTER TABLE transfer_charter_prices DROP COLUMN IF EXISTS place_id;
-- COMMIT;
