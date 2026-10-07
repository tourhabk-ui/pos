-- 1173: цена тура по размеру группы (issue #2246).
--
-- У тура была ОДНА цена (`base_price`) и единица (`price_unit`). Туры «Края
-- Вулканов» на их витрине показывают две: облёт Ключевской группы — 520 000 ₽
-- с человека при группе от 6 и 410 000 ₽ от 9; автотур на Курильское — 170 000
-- от 6 и 150 000 от 9 (переписка владельца с оператором 06–07.10; оператор
-- ответил «давай попробуем»). С одной ценой `get_tour_availability(people=9)`
-- назвал бы сумму, которой оператор не обещал, а заявка ушла бы ему с ней же.
--
-- ── Что это ───────────────────────────────────────────────────────────────
--
-- Ступень = «от min_people до max_people (NULL — без верхней границы) цена за
-- человека такая». Тур БЕЗ ступеней работает как раньше: ни строки не меняется.
-- Ступени заводятся только по подтверждённым оператором данным; пустая таблица
-- — норма, а не недоделка.
--
-- Это абсолютная цена, а не множитель: правила `tour_pricing_rules.group_discount`
-- (скидка за группу в процентах) остаются и применяются ПОВЕРХ цены ступени.
--
-- ── Чего таблица не делает ────────────────────────────────────────────────
--
-- Перекрытие диапазонов базой не запрещено (нужен btree_gist, а расширение на
-- проде не заводилось): при перекрытии код берёт ступень с БОЛЬШИМ min_people,
-- то есть самую конкретную, и это записано в `lib/tours/price-tiers.ts`.
-- Единица цены у тура со ступенями обязана быть per_person; иначе расчёт
-- отказывается называть сумму (см. там же).
--
-- IDEMPOTENT

BEGIN;

CREATE TABLE IF NOT EXISTS tour_price_tiers (
  id               BIGSERIAL PRIMARY KEY,
  operator_tour_id BIGINT NOT NULL REFERENCES operator_tours(id) ON DELETE CASCADE,
  min_people       INT NOT NULL CHECK (min_people >= 1),
  max_people       INT CHECK (max_people IS NULL OR max_people >= min_people),
  price_per_person NUMERIC(12,2) NOT NULL CHECK (price_per_person > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tour_price_tiers_tour_min_uniq UNIQUE (operator_tour_id, min_people)
);

COMMENT ON TABLE tour_price_tiers IS
  'Цена за человека по размеру группы. Нет строк у тура — действует base_price. Группа вне всех ступеней — цена «уточняется у оператора», сумма не считается.';

COMMIT;
