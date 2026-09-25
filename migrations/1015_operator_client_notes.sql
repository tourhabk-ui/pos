-- 1015: заметки оператора о своём клиенте — теги и Telegram.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- CRM-карточка клиента (/api/operator/clients/[id], PATCH) писала теги и
-- telegram клиента в users.preferences — ОБЩИЙ профиль туриста. Следствия:
--   * два оператора одного туриста перезаписывали теги друг друга
--     («VIP» у одного, «проблемный» у другого — видел последний записавший);
--   * пометки оператора ложились в личный профиль туриста, где им не место:
--     это суждение оператора о клиенте, а не настройка самого человека.
--
-- Готовой таблицы под заметки оператора о клиенте в схеме нет (проверено по
-- migrations/ и baseline). Поэтому своя таблица, ключ — пара
-- (оператор, клиент): у каждого оператора своя запись о том же человеке.
--
-- Перенос старых значений из users.preferences НЕ делается намеренно: там
-- не записано, КАКОЙ оператор их поставил, а приписать чужие теги первому
-- попавшемуся оператору значило бы выдумать авторство. Старые ключи
-- preferences остаются нетронутыми; кабинет их больше не читает.

CREATE TABLE IF NOT EXISTS operator_client_notes (
  operator_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  telegram    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operator_id, user_id)
);

COMMENT ON TABLE operator_client_notes IS
  'Заметки оператора о своём клиенте (теги, Telegram). Своя строка на пару оператор-клиент; users.preferences не трогается.';
COMMENT ON COLUMN operator_client_notes.telegram IS
  'Username без @ или числовой id Telegram; NULL — оператор не записывал.';
