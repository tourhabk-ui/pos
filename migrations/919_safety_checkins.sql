-- 919: Гостевой опыт после ЧП, часть 2 — лёгкий чек-ин «я в порядке» (issue #1420).
--
-- НЕ SOS. SOS — единственный канал экстренного вызова (app/api/safety/sos,
-- §7 CLAUDE.md — трогать только через staging), и у него отдельная кнопка
-- (components/shared/EmergencyAction.tsx). Чек-ин — мягкий необязательный
-- сигнал с /safety (куда уже ведёт push из external_alerts), не действие,
-- запускающее чью-то реакцию. Смешивать эти две кнопки нельзя: расходящееся
-- поведение одного действия уже случалось (#887).
--
-- Анонимно, без user_id: на /safety нет логина, а требовать его ради
-- необязательного сигнала значит не получить сигнал вовсе (тот же выбор,
-- что и в route_field_checks, миграция 898).
--
-- zone/lat/lng — необязательны: геолокация в браузере может быть не
-- разрешена, и это законное состояние (§4.0 — третье состояние), не ошибка.
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS safety_checkins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone       VARCHAR(20),
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safety_checkins_created ON safety_checkins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_checkins_zone ON safety_checkins(zone) WHERE zone IS NOT NULL;
