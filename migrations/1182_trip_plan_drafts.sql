-- 1182: черновики плана поездки для правки диалогом (#2224).
--
-- make_trip_plan у Кузьмича и в публичном MCP строил план с нуля на каждый
-- вызов: у плана не было id, и «добавь день рыбалки» значило собрать всё
-- заново — с другим порядком дней и другими турами. Правке нужен план,
-- который лежит где-то между вызовами.
--
-- Решения владельца 08.10:
--   - хранить черновики БЕЗ привязки к пользователю, 7 дней: туристы в MCP
--     и в Telegram в основном анонимны, а user_trips.user_id NOT NULL;
--   - хранить разобранную структуру И текст пожеланий туриста. Текст
--     проходит redactPII до записи — телефоны и почта в черновик не попадают
--     (pd-guard: черновик читает инструмент, чей ответ уходит в модель).
--
-- Доступ — знанием id (UUID): у анонимного черновика нет владельца, которого
-- можно было бы сверить, и угадать id нельзя. Истёкший черновик читается как
-- несуществующий; удаляет истёкшие сам писатель при каждой записи
-- (lib/planner/plan-drafts), отдельного крона нет.
--
-- params — вход движка (интересы ключами, даты, состав, уровень жилья,
-- стиль); days — дни плана как их отдал движок; revision растёт с каждой
-- правкой, чтобы ответ мог сказать «правка N».

CREATE TABLE IF NOT EXISTS trip_plan_drafts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  params      JSONB       NOT NULL,
  days        JSONB       NOT NULL,
  wishes      TEXT,
  surface     TEXT        NOT NULL CHECK (surface IN ('chat', 'mcp')),
  revision    INTEGER     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_trip_plan_drafts_expires
  ON trip_plan_drafts (expires_at);

COMMENT ON TABLE trip_plan_drafts IS
  'Черновики плана поездки без пользователя (#2224): правка диалогом, срок 7 дней.';
COMMENT ON COLUMN trip_plan_drafts.wishes IS
  'Текст пожеланий туриста после redactPII; сырой текст не хранится.';
