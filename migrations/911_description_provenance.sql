-- Migration 911: у описания появляется происхождение.
--
-- ФАКТ. lib/agents/editor.ts писал `UPDATE agent_route_knowledge SET
-- description = $1` и ничего больше. Ни отметки в строке, ни записи в журнал.
-- Значит текст, сочинённый моделью, и текст из источника в базе НЕОТЛИЧИМЫ —
-- ни при разборе жалобы, ни при попытке посчитать масштаб.
--
-- Владелец 23.08: «Editor не сверяется с фактами о месте, часто сочиняет».
-- Проверить это утверждение по базе сегодня нельзя ничем, кроме косвенных
-- улик, — и именно потому, что происхождения нет.
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ КОЛОНКА. agent_route_knowledge — это VIEW
-- (миграция 677) над places и kamchatka_routes, запись идёт через INSTEAD OF
-- триггеры, обновляющие строку мастера целиком. Новая колонка потребовала бы
-- трогать обе мастер-таблицы и оба триггера ради журнала. Журнал — не свойство
-- места, а событие: кто, когда и ИЗ ЧЕГО написал текст.
--
-- `facts_given` хранит ровно те факты, которые ушли в промпт. Без этого поля
-- запись отвечала бы «текст машинный», но не отвечала бы на главный вопрос —
-- было ли из чего писать. Пустой список фактов при длинном описании и есть
-- отпечаток выдумки.

CREATE TABLE IF NOT EXISTS description_provenance (
  id            BIGSERIAL PRIMARY KEY,
  entity_id     UUID        NOT NULL,
  entity_kind   TEXT        NOT NULL,           -- 'place' | 'route' | 'unknown'
  entity_title  TEXT,
  written_by    TEXT        NOT NULL,           -- 'editor-ai'
  model         TEXT,                           -- какая модель ответила; NULL — не выяснено
  facts_given   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  facts_count   INT         NOT NULL DEFAULT 0,
  chars         INT,
  previous_chars INT,                           -- сколько было до правки; NULL — описания не было
  written_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_description_provenance_entity
  ON description_provenance (entity_id, written_at DESC);

CREATE INDEX IF NOT EXISTS idx_description_provenance_written_at
  ON description_provenance (written_at DESC);

COMMENT ON TABLE description_provenance IS
  'Кто и из каких фактов написал описание места или маршрута. Пустой facts_given при длинном тексте — отпечаток выдумки.';
