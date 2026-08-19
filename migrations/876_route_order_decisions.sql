-- 876: журнал решений по уборке маршрутов (Ф4 плана).
--
-- ── Зачем ──────────────────────────────────────────────────────────────────
--
-- Уборка маршрутов — это сотни поимённых решений: снять привязку точки,
-- признать запись местом, слить близнецов, оставить только ориентирование.
-- Каждое из них принимается один раз и живёт годами, а помнить, ПОЧЕМУ так
-- решили, не будет никто.
--
-- Без журнала это кончается одинаково: через месяц запись выглядит странно,
-- кто-то её «чинит» обратно, и работа делается второй раз в обратную сторону.
-- Хуже — решение «оставить только ориентирование» неотличимо от «до неё не
-- дошли руки», и очередь никогда не заканчивается.
--
-- ── Что записывается ───────────────────────────────────────────────────────
--
--   reason      — из какой очереди запись взята (lib/routes/cleanup-queue)
--   decision    — что сделали: kept_orientation / link_removed / merged /
--                 reclassified / confirmed_navigable / no_change
--   evidence    — НА ЧТО опирались. Пустая улика — не решение, а мнение
--   note        — свободное пояснение человеку
--
-- Запись НЕ удаляется вместе с маршрутом (ON DELETE CASCADE здесь нет
-- намеренно): «эту запись слили с другой» — факт, который переживает саму
-- запись, и потерять его вместе с ней значит потерять историю слияния.
-- route_id хранится текстом ровно по той же причине, по которой 874 сверяет
-- идентификаторы текстом: id в этой схеме живёт в разных типах, а журналу
-- всё равно, какого типа был ушедший маршрут.
--
-- Решений на маршрут может быть несколько: сначала сняли привязку, позже
-- признали пригодным. Поэтому ключ — суррогатный, а не route_id.

CREATE TABLE IF NOT EXISTS route_order_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id    TEXT NOT NULL,
  route_title TEXT,
  reason      VARCHAR(32) NOT NULL,
  decision    VARCHAR(32) NOT NULL,
  evidence    TEXT NOT NULL,
  note        TEXT,
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_order_decisions_route
  ON route_order_decisions (route_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_order_decisions_reason
  ON route_order_decisions (reason, decided_at DESC);

INSERT INTO _migrations (name)
VALUES ('876_route_order_decisions.sql')
ON CONFLICT (name) DO NOTHING;
